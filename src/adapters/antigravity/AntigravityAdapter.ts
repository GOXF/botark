import { createId } from '@shared/id'
import type { AntigravityTurnEvent } from '../../main/antigravity/antigravityProtocol'
import { getBotHubBridge } from '../meta-muse/electronBridge'
import { statusAfterSendFailure } from '../sendFailure'
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

interface TurnOutcome {
  hasReply: boolean
  sessionId?: string
}

interface PendingTurn {
  id: string
  conversationId: string
  waiting: boolean
  acceptedAt?: number
  onAccepted?: () => void
  resolve: (outcome: TurnOutcome) => void
  reject: (error: AdapterError) => void
  cleanupAbort?: () => void
}

/**
 * Google Antigravity Cloud Agents adapter (`https://antigravity.google.com/`).
 *
 * Uses Google first-party sign-in inside an isolated Electron partition, then
 * talks directly to `JetskiRemoteAgentProxyService` (`aicode.clients6.google.com`)
 * with real-time `StreamAgentStateUpdates` streaming.
 */
export class AntigravityAdapter implements PlatformAdapter {
  readonly id = 'antigravity' as const
  readonly name = 'Antigravity'

  private readonly accounts = new Map<string, PlatformAccount>()
  private readonly statuses = new Map<string, ConnectionStatus>()
  private readonly listeners = new Set<AdapterListener>()
  private readonly pendingTurns = new Map<string, PendingTurn>()
  private bridgeUnsub: Unsubscribe | null = null

  constructor() {
    this.bindBridgeEvents()
  }

  private bindBridgeEvents(): void {
    const b = getBotHubBridge()
    if (!b?.antigravity || this.bridgeUnsub) return
    this.bridgeUnsub = b.antigravity.onEvent((event) => this.handleMainEvent(event))
  }

  private handleMainEvent(event: AntigravityTurnEvent): void {
    if (event.type !== 'login') {
      const turn = this.pendingTurns.get(event.accountId)
      if (!turn || event.messageId !== turn.id) return
      if (event.type === 'activity') {
        this.emit({
          type: 'activity',
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
        if (event.activityCode === 'needs_approval') {
          turn.waiting = true
          this.setStatus(event.accountId, 'attention', event.activityText ?? undefined)
        } else if (event.busy) {
          turn.waiting = false
          if (this.getStatus(event.accountId) !== 'busy') this.setStatus(event.accountId, 'busy')
        }
        return
      }

      this.acceptTurn(turn)
      if (event.error) {
        const failure = this.sendError(event.error.status, event.error.message)
        this.rejectPendingTurn(event.accountId, failure)
        this.emitIdle(event.accountId)
        this.setStatus(event.accountId, statusAfterSendFailure(failure), failure.message)
        return
      }

      const hasReply = Boolean(event.text || event.tools?.length)
      const replyId = `agy_reply_${turn.id}`
      if (event.waitingForApproval) turn.waiting = true
      this.emit({
        type: 'typing',
        sessionId: event.sessionId,
        conversationId: turn.conversationId,
        accountId: event.accountId,
        isTyping: !event.done && !turn.waiting
      })
      if (!event.done && !turn.waiting && hasReply) {
        this.emit({
          type: 'message_delta',
          sessionId: event.sessionId,
          messageId: replyId,
          conversationId: turn.conversationId,
          accountId: event.accountId,
          text: event.text,
          tools: event.tools
        })
      }
      if (event.waitingForApproval) {
        this.setStatus(event.accountId, 'attention')
        turn.resolve({ hasReply, sessionId: event.sessionId })
      } else if (event.done) {
        this.clearTurn(event.accountId, turn)
        this.emitIdle(event.accountId)
        this.setStatus(event.accountId, 'online')
        turn.resolve({ hasReply, sessionId: event.sessionId })
      }
      if ((event.done || turn.waiting) && hasReply) {
        this.emit({
          type: 'message',
          message: {
            id: replyId,
            sessionId: event.sessionId,
            conversationId: turn.conversationId,
            accountId: event.accountId,
            text: event.text,
            createdAt: Date.now(),
            tools: event.tools
          }
        })
      }
      return
    }

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
        platformId: 'antigravity',
        displayName: event.displayName ?? existing?.displayName ?? 'Antigravity',
        handle: event.handle ?? existing?.handle ?? event.accountId
      })
      this.setStatus(event.accountId, 'online')
      return
    }

    this.rejectPendingTurn(event.accountId, new AdapterError('not-connected', 'Signed out'))
    this.emit({
      type: 'login',
      accountId: event.accountId,
      signedIn: false,
      windowClosed: event.windowClosed
    })
    this.setStatus(event.accountId, 'offline')
  }

  private acceptTurn(turn: PendingTurn): void {
    if (turn.acceptedAt !== undefined) return
    turn.acceptedAt = Date.now()
    turn.onAccepted?.()
  }

  private sendError(status: number, message: string): AdapterError {
    return new AdapterError(status === 401 || status === 403 ? 'not-connected' : 'network', message)
  }

  private clearTurn(accountId: string, turn: PendingTurn): void {
    if (this.pendingTurns.get(accountId) === turn) this.pendingTurns.delete(accountId)
    turn.cleanupAbort?.()
  }

  private rejectPendingTurn(accountId: string, error: AdapterError): void {
    const turn = this.pendingTurns.get(accountId)
    if (!turn) return
    this.clearTurn(accountId, turn)
    this.emit({ type: 'typing', conversationId: turn.conversationId, accountId, isTyping: false })
    turn.reject(error)
  }

  private emitIdle(accountId: string): void {
    this.emit({
      type: 'activity',
      accountId,
      activity: { code: 'idle', text: null, emoji: null, agentId: null, subagents: 0, busy: false }
    })
  }

  private emit(event: AdapterEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[antigravity] listener error', error)
      }
    }
  }

  private setStatus(accountId: string, status: ConnectionStatus, detail?: string): void {
    this.statuses.set(accountId, status)
    this.emit({ type: 'status', accountId, status, detail })
  }

  async listAccounts(): Promise<PlatformAccount[]> {
    return [...this.accounts.values()]
  }

  getStatus(accountId: string): ConnectionStatus {
    return this.statuses.get(accountId) ?? 'offline'
  }

  async connect(accountId: string): Promise<ConnectionStatus> {
    this.bindBridgeEvents()
    const bridge = getBotHubBridge()?.antigravity
    if (!bridge) {
      this.setStatus(accountId, 'offline', 'Electron main required')
      return 'offline'
    }
    try {
      const status = await bridge.authStatus(accountId)
      if (status.signedIn) {
        const existing = this.accounts.get(accountId)
        this.accounts.set(accountId, {
          id: accountId,
          platformId: 'antigravity',
          displayName: status.displayName ?? existing?.displayName ?? 'Antigravity',
          handle: status.handle ?? existing?.handle ?? accountId
        })
        this.setStatus(accountId, 'online')
        return 'online'
      }
      this.setStatus(accountId, 'offline', status.error || '需要重新登录 Google Antigravity')
      return 'offline'
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.setStatus(accountId, 'error', msg)
      return 'error'
    }
  }

  async disconnect(accountId: string): Promise<void> {
    this.rejectPendingTurn(accountId, new AdapterError('not-connected', 'Disconnected'))
    const bridge = getBotHubBridge()?.antigravity
    await bridge?.cancelRun(accountId).catch(() => undefined)
    this.setStatus(accountId, 'offline')
  }

  async openLogin(accountId: string): Promise<ConnectionStatus> {
    this.bindBridgeEvents()
    const bridge = getBotHubBridge()?.antigravity
    if (!bridge) {
      throw new AdapterError('not-connected', 'Antigravity IPC unavailable')
    }
    const status = await bridge.openLogin({ accountId })
    if (status.signedIn) {
      this.accounts.set(accountId, {
        id: accountId,
        platformId: 'antigravity',
        displayName: status.displayName ?? 'Antigravity',
        handle: status.handle ?? accountId
      })
      this.setStatus(accountId, 'online')
      return 'online'
    }
    this.setStatus(accountId, 'offline', '在弹出的窗口里完成 Google Antigravity 登录')
    return 'offline'
  }

  async cancelLogin(accountId: string): Promise<void> {
    this.rejectPendingTurn(accountId, new AdapterError('not-connected', 'Login cancelled'))
    const bridge = getBotHubBridge()?.antigravity
    await bridge?.cancelLogin(accountId).catch(() => undefined)
    this.accounts.delete(accountId)
    this.statuses.delete(accountId)
  }

  async sendMessage(message: OutgoingMessage): Promise<SendReceipt> {
    this.bindBridgeEvents()
    const bridge = getBotHubBridge()?.antigravity
    if (!bridge) {
      throw new AdapterError('not-connected', 'Antigravity IPC unavailable')
    }
    if (message.signal?.aborted) {
      throw new AdapterError('network', 'Aborted')
    }

    const { accountId, signal } = message
    this.rejectPendingTurn(accountId, new AdapterError('network', 'Superseded by new message'))

    const id = createId('agy_msg')
    let resolveTurn!: PendingTurn['resolve']
    let rejectTurn!: PendingTurn['reject']
    const completion = new Promise<TurnOutcome>((resolve, reject) => {
      resolveTurn = resolve
      rejectTurn = reject
    })
    let rejectInterrupted!: PendingTurn['reject']
    const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject })
    // Cancellation can arrive before IPC acknowledges the send.
    void completion.catch(() => undefined)
    void interrupted.catch(() => undefined)
    const turn: PendingTurn = {
      id,
      conversationId: message.conversationId,
      waiting: false,
      onAccepted: message.onAccepted,
      resolve: resolveTurn,
      reject: (error) => {
        rejectTurn(error)
        rejectInterrupted(error)
      }
    }
    this.pendingTurns.set(accountId, turn)

    const onAbort = () => {
      if (this.pendingTurns.get(accountId) !== turn) return
      this.rejectPendingTurn(accountId, new AdapterError('network', 'Aborted'))
      void bridge.cancelRun(accountId).catch(() => undefined)
      this.emitIdle(accountId)
      this.setStatus(accountId, 'online')
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
      turn.cleanupAbort = () => signal.removeEventListener('abort', onAbort)
    }

    try {
      this.setStatus(accountId, 'busy')
      signal?.throwIfAborted()
      const response = await Promise.race([
        bridge.sendMessage({
          accountId,
          conversationId: message.conversationId,
          sessionId: message.sessionId,
          text: message.text,
          clientMessageId: id
        }),
        interrupted
      ])
      if (!response.ok) throw this.sendError(response.status, response.message)
      if (response.messageId !== id) throw new AdapterError('network', 'Antigravity acknowledged a different message')
      this.acceptTurn(turn)

      const outcome = await completion
      return {
        messageId: id,
        acceptedAt: turn.acceptedAt ?? Date.now(),
        sessionId: response.cascadeId || outcome.sessionId,
        ...(outcome.hasReply ? {} : { noReply: true })
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const failure = error instanceof AdapterError ? error : new AdapterError('network', detail)
      if (this.pendingTurns.get(accountId) === turn) {
        this.rejectPendingTurn(accountId, failure)
        this.emitIdle(accountId)
        this.setStatus(accountId, statusAfterSendFailure(failure), failure.message)
      }
      throw failure
    }
  }

  subscribe(listener: AdapterListener): Unsubscribe {
    this.bindBridgeEvents()
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onMessage(listener: (message: IncomingMessage) => void): Unsubscribe {
    return this.subscribe((event) => {
      if (event.type === 'message') listener(event.message)
    })
  }
}

export function createAntigravityAdapter(): AntigravityAdapter {
  return new AntigravityAdapter()
}
