import { statusAfterSendFailure } from '../sendFailure'
import { createId } from '@shared/id'
import type { DotRpcResponse } from '@shared/ipc'
import type { DotTurnEvent, DotTurnRequest } from '@shared/dotTarget'
import { getBotHubBridge } from '../meta-muse/electronBridge'
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

async function invokeDotRpc(request: DotTurnRequest): Promise<unknown> {
  const bridge = getBotHubBridge()?.dot
  if (!bridge?.rpc) {
    throw new AdapterError('not-connected', 'Dot IPC unavailable (Electron main required)')
  }
  const res = (await bridge.rpc(request)) as DotRpcResponse
  if (!res.ok) {
    throw new AdapterError(
      res.status === 401 ? 'not-connected' : 'network',
      res.message || `Dot RPC failed (${res.status})`
    )
  }
  return res.data
}

/**
 * OpenAI Dot (`chatgpt.com/dots`) platform adapter:
 * - Calpico Room REST + Celsius Real-time WebSocket (`wss://ws.chatgpt.com/p20/ws/user/...`)
 * - Native `gpt-6-astra` / `gpt-6.1-sol` App-Server WebSocket (`wss://codex-cloud-backend.chatgpt.com/`)
 * - Supports interactive ChatGPT browser login and `access_token` (AT) / `refresh_token` (RT) / JSON import.
 */
export class DotAdapter implements PlatformAdapter {
  readonly id = 'dot' as const
  readonly name = 'Dot'

  private readonly accounts = new Map<string, PlatformAccount>()
  private readonly statuses = new Map<string, ConnectionStatus>()
  private readonly listeners = new Set<AdapterListener>()
  private readonly disconnected = new Set<string>()
  private readonly connectionChecks = new Map<string, symbol>()
  private readonly pendingTurns = new Map<string, {
    id: string
    accept?: () => void
    hasReply: boolean
    emittedReplies: Set<string>
  }>()
  private bridgeUnsub: Unsubscribe | null = null

  constructor() {
    this.bindBridgeEvents()
  }

  private bindBridgeEvents(): void {
    const b = getBotHubBridge()
    if (!b?.dot || this.bridgeUnsub) return
    this.bridgeUnsub = b.dot.onEvent((event) => this.handleMainEvent(event))
  }

  private handleMainEvent(event: DotTurnEvent): void {
    const pending = this.pendingTurns.get(event.accountId)
    if (event.type !== 'login' && (
      this.disconnected.has(event.accountId) || (event.turnId && event.turnId !== pending?.id)
    )) return
    if (event.type === 'sent') {
      if (pending) {
        const accept = pending.accept
        pending.accept = undefined
        accept?.()
      }
      return
    }
    if (event.type === 'activity') {
      this.emit({
        type: 'activity',
        sessionId: event.roomId,
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
      if (!event.busy) {
        this.emit({
          type: 'typing',
          sessionId: event.roomId,
          conversationId: event.accountId,
          accountId: event.accountId,
          isTyping: false
        })
        this.setStatus(event.accountId, 'online')
      } else if (this.getStatus(event.accountId) === 'offline') {
        this.setStatus(event.accountId, 'busy')
      }
      return
    }

    if (event.type === 'stream') {
      const convId = event.conversationId ?? event.accountId
      if (!event.done) {
        if (this.getStatus(event.accountId) === 'offline') {
          this.setStatus(event.accountId, 'busy')
        }
        this.emit({
          type: 'typing',
            sessionId: event.roomId,
          conversationId: convId,
          accountId: event.accountId,
          isTyping: true
        })
        if (event.text || event.tools?.length || event.richWidgets?.length || event.media?.length) {
          if (pending && pending.id === event.turnId) pending.hasReply = true
          this.emit({
            type: 'message_delta',
            sessionId: event.roomId,
            messageId: event.messageId,
            conversationId: convId,
            accountId: event.accountId,
            text: event.text,
            tools: event.tools,
            richWidgets: event.richWidgets,
            media: event.media
          })
        }
      } else {
        const keepBusy = Boolean(event.stillBusy)
        if (!keepBusy) {
          this.emit({
            type: 'typing',
            sessionId: event.roomId,
            conversationId: convId,
            accountId: event.accountId,
            isTyping: false
          })
          this.emit({
            type: 'activity',
            sessionId: event.roomId,
            accountId: event.accountId,
            activity: {
              code: 'idle',
              text: null,
              emoji: null,
              agentId: null,
              subagents: 0,
              busy: false
            }
          })
          this.setStatus(event.accountId, 'online')
        } else if (this.getStatus(event.accountId) === 'offline') {
          this.setStatus(event.accountId, 'busy')
        }
        if (
          event.text ||
          event.tools?.length ||
          event.richWidgets?.length ||
          event.media?.length
        ) {
          if (pending && pending.id === event.turnId) {
            pending.hasReply = true
            pending.emittedReplies.add(event.messageId)
          }
          this.emit({
            type: 'message',
            message: {
              sessionId: event.roomId,
              id: event.messageId,
              conversationId: convId,
              accountId: event.accountId,
              text: event.text,
              createdAt: Date.now(),
              tools: event.tools,
              richWidgets: event.richWidgets,
              media: event.media
            }
          })
        }
      }
      return
    }

    if (event.type === 'login') {
      if (event.signedIn) {
        this.disconnected.delete(event.accountId)
        this.emit({
          type: 'login',
          accountId: event.accountId,
          signedIn: true,
          handle: event.handle,
          displayName: event.displayName
        })
        this.upsert(event.accountId, {
          displayName: event.displayName,
          handle: event.handle
        })
        this.setStatus(event.accountId, 'online')
      } else {
        this.disconnected.add(event.accountId)
        this.connectionChecks.delete(event.accountId)
        this.pendingTurns.delete(event.accountId)
        this.emit({
          type: 'login',
          accountId: event.accountId,
          signedIn: false,
          windowClosed: event.windowClosed
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
        console.error('[dot] listener failed', error)
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
      platformId: 'dot',
      displayName: patch?.displayName ?? prev?.displayName ?? 'Dot',
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
    const bridge = getBotHubBridge()?.dot
    if (!bridge) {
      this.setStatus(accountId, 'offline', '需要 Electron')
      return 'offline'
    }
    const check = Symbol()
    this.connectionChecks.set(accountId, check)
    const ownsCheck = () => this.connectionChecks.get(accountId) === check
    this.disconnected.delete(accountId)
    try {
      const status = await bridge.authStatus(accountId)
      if (!ownsCheck()) return this.getStatus(accountId)
      if (!status.signedIn) {
        this.setStatus(accountId, 'offline', '未导入 Codex/Dot 凭据或未登录')
        return 'offline'
      }
      this.upsert(accountId, { displayName: status.displayName, handle: status.handle })
      if (status.mode !== 'native') {
        await invokeDotRpc({ accountId, op: 'listDots', ensureDefault: true })
        if (!ownsCheck()) return this.getStatus(accountId)
      }
      this.setStatus(accountId, 'online')
      return 'online'
    } catch (error) {
      if (!ownsCheck()) return this.getStatus(accountId)
      const detail = error instanceof Error ? error.message : String(error)
      this.setStatus(accountId, 'error', detail)
      return 'error'
    } finally {
      if (ownsCheck()) this.connectionChecks.delete(accountId)
    }
  }

  async disconnect(accountId: string): Promise<void> {
    this.disconnected.add(accountId)
    this.connectionChecks.delete(accountId)
    this.pendingTurns.delete(accountId)
    this.setStatus(accountId, 'offline')
    if (getBotHubBridge()?.dot) {
      await invokeDotRpc({ accountId, op: 'cancelTurn', disconnect: true })
    }
  }

  async openLogin(accountId: string, _botId?: string): Promise<ConnectionStatus> {
    this.bindBridgeEvents()
    this.upsert(accountId)
    const bridge = getBotHubBridge()?.dot
    if (!bridge?.openLogin) {
      throw new AdapterError('unsupported', 'Dot login needs the Electron app')
    }
    this.setStatus(accountId, 'offline', '在弹窗完成 ChatGPT 登录，或导入 AT / RT 凭据')
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
    const bridge = getBotHubBridge()?.dot
    await bridge?.cancelLogin?.(accountId)
    this.accounts.delete(accountId)
    this.statuses.delete(accountId)
    this.disconnected.add(accountId)
    this.connectionChecks.delete(accountId)
    this.pendingTurns.delete(accountId)
  }

  async sendMessage(message: OutgoingMessage): Promise<SendReceipt> {
    this.bindBridgeEvents()
    if (message.signal?.aborted) throw new AdapterError('network', 'Aborted')
    if (this.disconnected.has(message.accountId)) throw new AdapterError('not-connected', 'Dot is disconnected')

    const turn = { id: createId('dot_turn'), accept: message.onAccepted, hasReply: false, emittedReplies: new Set<string>() }
    this.pendingTurns.set(message.accountId, turn)
    this.setStatus(message.accountId, 'busy')
    try {
      return await this.sendTracked(message, turn)
    } finally {
      if (this.pendingTurns.get(message.accountId) === turn) this.pendingTurns.delete(message.accountId)
    }
  }

  private async sendTracked(
    message: OutgoingMessage,
    turn: { id: string; hasReply: boolean; emittedReplies: Set<string> }
  ): Promise<SendReceipt> {
    const ownsTurn = () => this.pendingTurns.get(message.accountId) === turn
    this.emit({
      type: 'typing',
      conversationId: message.conversationId,
      accountId: message.accountId,
      isTyping: true
    })

    const rpcPromise = invokeDotRpc({
      accountId: message.accountId,
      op: 'sendMessage',
      botId: message.conversationId,
      turnId: turn.id,
      roomId: message.sessionId,
      text: message.text,
      attachments: message.attachments
        ?.filter((a) => Boolean(a.dataBase64))
        .map((a) => ({
          name: a.name,
          mimeType: a.mimeType,
          dataBase64: a.dataBase64!
        }))
    })

    const raceSignal = <T>(p: Promise<T>): Promise<T> => {
      const signal = message.signal
      if (!signal) return p
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          void invokeDotRpc({
            accountId: message.accountId,
            op: 'cancelTurn',
            turnId: turn.id
          }).catch(() => undefined)
          reject(new AdapterError('network', 'Aborted'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
        p.then(
          (val) => {
            signal.removeEventListener('abort', onAbort)
            resolve(val)
          },
          (err) => {
            signal.removeEventListener('abort', onAbort)
            reject(err)
          }
        )
      })
    }

    try {
      const res = (await raceSignal(rpcPromise)) as {
        mode?: 'dot' | 'native'
        roomId?: string
        threadId?: string
        replies?: Array<{
          id: string
          text?: string
          content?: string
          media?: import('@shared/ipc').MuseMediaPartView[]
        }>
        reply?: {
          id: string
          text?: string
          content?: string
          tools?: import('../types').MuseToolCall[]
          media?: import('@shared/ipc').MuseMediaPartView[]
        } | null
      }

      if (!ownsTurn() || message.signal?.aborted) throw new AdapterError('network', 'Aborted')

      this.emit({
        type: 'typing',
        conversationId: message.conversationId,
        accountId: message.accountId,
        isTyping: false
      })
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

      if (Array.isArray(res?.replies) && res.replies.length > 0) {
        for (const r of res.replies) {
          const rText = (r.text ?? r.content ?? '').trim()
          const rMedia = r.media
          if (rText || rMedia?.length) {
            const rId = r.id.startsWith('dot_') ? r.id : `dot_${r.id}`
            if (turn.emittedReplies.has(rId)) continue
            this.emit({
              type: 'message',
              message: {
                id: rId,
                sessionId: res.roomId,
                conversationId: message.conversationId,
                accountId: message.accountId,
                text: rText,
                createdAt: Date.now(),
                ...(rMedia?.length ? { media: rMedia } : {})
              }
            })
          }
        }
      } else {
        const replyText = (res?.reply?.text ?? res?.reply?.content ?? '').trim()
        const replyTools = res?.reply?.tools
        const replyMedia = res?.reply?.media
        if ((replyText || replyTools?.length || replyMedia?.length) && !turn.emittedReplies.has(res?.reply?.id ?? '')) {
          const incoming: IncomingMessage & {
            tools?: import('../types').MuseToolCall[]
            media?: import('@shared/ipc').MuseMediaPartView[]
          } = {
            id: res?.reply?.id || createId('msg'),
            sessionId: res?.roomId,
            conversationId: message.conversationId,
            accountId: message.accountId,
            text: replyText,
            createdAt: Date.now(),
            ...(replyTools?.length ? { tools: replyTools } : {}),
            ...(replyMedia?.length ? { media: replyMedia } : {})
          }
          this.emit({ type: 'message', message: incoming })
        }
      }

      this.setStatus(message.accountId, 'online')
      const gotReply =
        turn.hasReply ||
        (Array.isArray(res?.replies) &&
          res.replies.some((r) => (r.text ?? r.content ?? '').trim() || r.media?.length)) ||
        Boolean((res?.reply?.text ?? res?.reply?.content ?? '').trim() || res?.reply?.tools?.length || res?.reply?.media?.length)
      return {
        messageId: createId('msg'),
        acceptedAt: Date.now(),
        sessionId:
          res?.mode === 'native'
            ? res?.threadId || message.sessionId
            : res?.roomId || res?.threadId || message.sessionId,
        ...(gotReply ? {} : { noReply: true })
      }
    } catch (error) {
      if (!ownsTurn()) throw error
      this.emit({
        type: 'typing',
        conversationId: message.conversationId,
        accountId: message.accountId,
        isTyping: false
      })
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
      if (message.signal?.aborted) {
        this.setStatus(message.accountId, 'online')
        throw error instanceof AdapterError ? error : new AdapterError('network', 'Aborted')
      }
      const detail = error instanceof Error ? error.message : String(error)
      const next = statusAfterSendFailure(error)
      this.setStatus(message.accountId, next, next === 'error' ? detail : undefined)
      throw error instanceof AdapterError ? error : new AdapterError('network', detail)
    }
  }

  subscribe(listener: AdapterListener): Unsubscribe {
    this.bindBridgeEvents()
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

export function createDotAdapter(): DotAdapter {
  return new DotAdapter()
}
