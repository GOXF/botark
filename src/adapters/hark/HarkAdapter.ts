import { statusAfterSendFailure } from '../sendFailure'
import { createId } from '@shared/id'
import type { HarkMainEvent } from '@shared/ipc'
import { harkProjectId } from '@shared/harkProjects'
import { getBotHubBridge } from '../meta-muse/electronBridge'
import { HARK_DRAFT_SESSION } from '@shared/harkProjects'
import { harkRpc, type HarkRequest } from './harkRequests'
import {
  AdapterError,
  type AdapterEvent,
  type AdapterListener,
  type ConnectionStatus,
  type IncomingMessage,
  type OutgoingMessage,
  type PlatformAccount,
  type PlatformAdapter,
  type SendReceipt,
  type Unsubscribe
} from '../types'

async function invokeHarkRpc(request: HarkRequest, signal?: AbortSignal): Promise<unknown> {
  const bridge = getBotHubBridge()?.hark
  if (!bridge?.rpc) {
    throw new AdapterError('not-connected', 'Hark IPC unavailable (Electron main required)')
  }
  const res = await harkRpc(bridge, request, signal)
  if (!res.ok) {
    if (request.op === 'sendMessage' && res.status === 0 &&
      (res.code === 'send-timeout' || res.message === 'Hark POST /api/messages/send timed out')) {
      throw new AdapterError('no-reply', 'Hark 发送超时，消息可能已经送达')
    }
    throw new AdapterError(
      res.status === 401 ? 'not-connected' : 'network',
      res.message || `Hark RPC failed (${res.status})`
    )
  }
  return res.data
}

/**
 * Hark platform adapter — Google better-auth login in a partition window,
 * then main-process REST for list / send / poll.
 */
export class HarkAdapter implements PlatformAdapter {
  readonly id = 'hark' as const
  readonly name = 'Hark'

  private readonly accounts = new Map<string, PlatformAccount>()
  private readonly statuses = new Map<string, ConnectionStatus>()
  private readonly listeners = new Set<AdapterListener>()
  private readonly publishedReplies = new Set<string>()
  private bridgeUnsub: Unsubscribe | null = null

  constructor() {
    this.bindBridgeEvents()
  }

  private bindBridgeEvents(): void {
    const b = getBotHubBridge()
    if (!b?.hark || this.bridgeUnsub) return
    this.bridgeUnsub = b.hark.onEvent((event) => this.handleMainEvent(event))
  }

  private handleMainEvent(event: HarkMainEvent): void {
    if (event.type === 'activity') {
      this.emit({
        type: 'activity',
        sessionId: event.sessionId,
        accountId: event.accountId,
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
    if (event.type === 'stream') {
      const convId = event.conversationId ?? event.accountId
      if (!event.done) {
        this.emit({
          type: 'typing',
          conversationId: convId,
          sessionId: event.sessionId,
          accountId: event.accountId,
          isTyping: true
        })
        if (event.text || event.tools?.length || event.media?.length || event.richWidgets?.length) {
          this.emit({
            type: 'message_delta',
            messageId: event.messageId,
            conversationId: convId,
            sessionId: event.sessionId,
            accountId: event.accountId,
            text: event.text,
            tools: event.tools,
            media: event.media,
            richWidgets: event.richWidgets
          })
        }
      } else {
        this.finishReply({
          id: event.messageId, conversationId: convId, sessionId: event.sessionId, accountId: event.accountId,
          text: event.text, createdAt: Date.now(), tools: event.tools, media: event.media, richWidgets: event.richWidgets
        })
      }
      return
    }
    if (event.type !== 'login') return
    if (event.signedIn) {
      this.emit({
        type: 'login',
        accountId: event.accountId,
        signedIn: true,
        handle: event.handle,
        displayName: event.displayName
      })
      const existing = this.accounts.get(event.accountId)
      this.accounts.set(event.accountId, {
        id: event.accountId,
        platformId: 'hark',
        displayName: event.displayName ?? existing?.displayName ?? 'Hark',
        handle: event.handle ?? existing?.handle ?? event.accountId
      })
      this.setStatus(event.accountId, 'online')
      return
    }
    this.emit({
      type: 'login',
      accountId: event.accountId,
      signedIn: false,
      windowClosed: event.windowClosed
    })
    this.setStatus(event.accountId, 'offline')
  }

  private emit(event: AdapterEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[hark] listener failed', error)
      }
    }
  }

  private setStatus(accountId: string, status: ConnectionStatus, detail?: string): void {
    this.statuses.set(accountId, status)
    this.emit({ type: 'status', accountId, status, detail })
  }

  private clearReplyActivity(accountId: string, conversationId: string, sessionId?: string): void {
    this.emit({ type: 'typing', accountId, conversationId, sessionId, isTyping: false })
    this.emit({
      type: 'activity', accountId, sessionId,
      activity: { code: 'idle', text: null, emoji: null, agentId: null, subagents: 0, busy: false }
    })
  }

  /** `tailing`: Hark's turn goes on, so keep the live status and let the tail's final `done` publish again. */
  private finishReply(message: IncomingMessage, tailing = false): void {
    const { accountId, conversationId, sessionId, id } = message
    const key = JSON.stringify([accountId, sessionId, id])
    if (this.publishedReplies.has(key)) return
    if (!tailing) this.clearReplyActivity(accountId, conversationId, sessionId)
    if (message.text || message.tools?.length || message.media?.length || message.richWidgets?.length) {
      if (!tailing) this.publishedReplies.add(key)
      if (this.publishedReplies.size > 512) this.publishedReplies.delete(this.publishedReplies.values().next().value!)
      this.emit({ type: 'message', message })
    }
  }

  private upsert(accountId: string, patch?: Partial<PlatformAccount>): void {
    const prev = this.accounts.get(accountId)
    this.accounts.set(accountId, {
      id: accountId,
      platformId: 'hark',
      displayName: patch?.displayName ?? prev?.displayName ?? 'Hark',
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
    const bridge = getBotHubBridge()?.hark
    if (!bridge) {
      this.setStatus(accountId, 'offline', '需要 Electron')
      return 'offline'
    }
    try {
      const status = await bridge.authStatus(accountId)
      if (!status.signedIn) {
        this.setStatus(accountId, 'offline', '未登录 Hark')
        return 'offline'
      }
      this.upsert(accountId, { displayName: status.displayName, handle: status.handle })
      this.setStatus(accountId, 'online')
      return 'online'
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.setStatus(accountId, 'error', detail)
      return 'error'
    }
  }

  async disconnect(accountId: string): Promise<void> {
    this.setStatus(accountId, 'offline')
  }

  async openLogin(accountId: string, _botId?: string): Promise<ConnectionStatus> {
    this.bindBridgeEvents()
    this.upsert(accountId)
    const bridge = getBotHubBridge()?.hark
    if (!bridge?.openLogin) {
      throw new AdapterError('unsupported', 'Hark login needs the Electron app')
    }
    this.setStatus(accountId, 'offline', '在弹出的窗口里完成 Google 登录')
    try {
      const status = await bridge.openLogin({ accountId })
      if (status.signedIn) {
        this.upsert(accountId, { displayName: status.displayName, handle: status.handle })
        this.setStatus(accountId, 'online')
        return 'online'
      }
      return this.getStatus(accountId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.setStatus(accountId, 'error', detail)
      return 'error'
    }
  }

  async cancelLogin(accountId: string): Promise<void> {
    const bridge = getBotHubBridge()?.hark
    await bridge?.cancelLogin?.(accountId)
    this.accounts.delete(accountId)
    this.statuses.delete(accountId)
  }

  async sendMessage(message: OutgoingMessage): Promise<SendReceipt> {
    message.signal?.throwIfAborted()
    this.bindBridgeEvents()
    const draft = message.sessionId === HARK_DRAFT_SESSION
    const sessionId = draft ? undefined : harkProjectId(message.sessionId)
    if (!draft && !sessionId && (message.sessionId !== undefined || message.conversationId.startsWith('room-turn-'))) {
      throw new AdapterError('network', 'No Hark project ID')
    }
    const before = (draft
      // Draft project: create it now, untitled, so Hark names it from this first message.
      ? { ...(await invokeHarkRpc({ accountId: message.accountId, op: 'createConversation', title: '' }) as { conversationId?: string }), messages: [] }
      : await invokeHarkRpc(sessionId
        ? { accountId: message.accountId, op: 'conversationSnapshot', conversationId: sessionId }
        : { accountId: message.accountId, op: 'mainConversation' }
      )) as { conversationId?: string; messages: Array<{ id: string }> } | null
    message.signal?.throwIfAborted()
    const conversationId = harkProjectId(before?.conversationId)
    if (!conversationId || (sessionId && sessionId !== conversationId)) {
      throw new AdapterError('network', 'No matching Hark conversation ID')
    }
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    this.setStatus(message.accountId, 'busy')
    this.emit({
      type: 'typing',
      sessionId: conversationId,
      conversationId: message.conversationId,
      accountId: message.accountId,
      isTyping: true
    })

    let accepted = false
    let settledByReply = false
    try {
      const beforeMsgs = Array.isArray(before?.messages) ? before.messages : []
      const afterIds = beforeMsgs.map((m) => m.id)

      const sent = (await invokeHarkRpc({
        accountId: message.accountId,
        op: 'sendMessage',
        conversationId,
        text: message.text,
        timezone: timeZone,
        attachments: message.attachments
          ?.filter((a) => Boolean(a.dataBase64))
          .map((a) => ({
            name: a.name,
            mimeType: a.mimeType,
            dataBase64: a.dataBase64!
          }))
      })) as {
        responseMessageId?: string
        idempotencyKey?: string
      }

      accepted = true
      const acceptedAt = Date.now()
      message.onAccepted?.(draft ? conversationId : undefined)
      message.signal?.throwIfAborted()
      if (sent?.idempotencyKey) afterIds.push(sent.idempotencyKey)

      const polled = (await invokeHarkRpc({
        accountId: message.accountId,
        op: 'pollReply',
        conversationId,
        botId: message.conversationId,
        responseMessageId: sent?.responseMessageId,
        timezone: timeZone,
        afterMessageIds: sent?.responseMessageId ? undefined : afterIds,
        requestId: createId('hark_watch'),
        timeoutMs: message.replyTimeoutMs ?? 90_000
      }, message.signal)) as {
        outcome?: 'completed' | 'timed-out' | 'cancelled' | 'failed'
        error?: string
        /** The reply is done but Hark's turn goes on; main clears the status when it ends. */
        tailing?: boolean
        reply?: {
          id: string
          content: string
          role: string
          tools?: import('../types').MuseToolCall[]
          media?: import('../types').MuseMediaPart[]
          richWidgets?: import('../types').MuseRichWidget[]
        } | null
      }

      message.signal?.throwIfAborted()
      if (polled?.outcome === 'cancelled') throw new AdapterError('no-reply', 'Hark 回复已取消')
      if (polled?.outcome === 'failed') throw new AdapterError('no-reply', polled.error || 'Hark 回复失败')
      const reply = polled?.outcome === 'timed-out' ? null : polled?.reply
      if (reply) {
        this.finishReply({
          id: reply.id.startsWith('hark_') ? reply.id : `hark_${reply.id}`,
          sessionId: conversationId,
          conversationId: message.conversationId,
          accountId: message.accountId,
          text: reply.content.trim(),
          createdAt: Date.now(),
          tools: reply.tools, media: reply.media, richWidgets: reply.richWidgets
        }, polled?.tailing)
        settledByReply = true
      }
      // GOXF: a tool-only first message counts as "completed" while Hark's turn goes on;
      // wait out the tail so its real answer reaches callers that listen per turn (rooms).
      if (polled?.tailing && !reply?.content.trim()) await this.waitForTail(conversationId, message.conversationId, message.signal)
      message.signal?.throwIfAborted()

      this.setStatus(message.accountId, 'online')
      return {
        messageId: sent?.idempotencyKey ?? createId('msg'),
        acceptedAt,
        sessionId: conversationId,
        ...(reply && (reply.content.trim() || reply.tools?.length || reply.media?.length || reply.richWidgets?.length)
          ? {} : { noReply: true })
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (error instanceof AdapterError && error.code === 'no-reply') {
        this.setStatus(message.accountId, 'online')
        throw error
      }
      if (accepted) {
        this.setStatus(message.accountId, 'online')
        if (message.signal?.aborted) {
          const cancelled = new AdapterError('no-reply', 'Hark 回复已取消')
          cancelled.name = 'AbortError'
          throw cancelled
        }
        throw new AdapterError('no-reply', `Hark 已收到消息，但读取回复失败：${detail}`)
      }
      const next = statusAfterSendFailure(error)
      this.setStatus(message.accountId, next, next === 'error' ? detail : undefined)
      throw error instanceof AdapterError ? error : new AdapterError('network', detail)
    } finally {
      if (!settledByReply) this.clearReplyActivity(message.accountId, message.conversationId, conversationId)
    }
  }

  /** Resolves once the tail has gone quiet: no new answer text and no activity for a moment. */
  private waitForTail(sessionId: string, conversationId: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let quiet: ReturnType<typeof setTimeout> | undefined
      const done = (): void => {
        clearTimeout(cap)
        clearTimeout(quiet)
        stop()
        signal?.removeEventListener('abort', done)
        resolve()
      }
      // Same 30-minute cap as the main-process tail (HARK_TAIL_CAP_MS).
      const cap = setTimeout(done, 30 * 60_000)
      const stop = this.subscribe((e) => {
        const answer = e.type === 'message' && e.message.conversationId === conversationId && Boolean(e.message.text)
        const idle = e.type === 'activity' && e.sessionId === sessionId && !e.activity.busy
        if (!answer && !idle) return
        clearTimeout(quiet)
        quiet = setTimeout(done, 1_500)
      })
      if (signal?.aborted) done()
      else signal?.addEventListener('abort', done, { once: true })
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

export function createHarkAdapter(): HarkAdapter {
  return new HarkAdapter()
}
