import { statusAfterSendFailure } from '../sendFailure'
import { createId } from '@shared/id'
import type { MuseMainEvent } from '@shared/ipc'
import {
  KNOWN_APPROVAL_DECISIONS,
  MuseApprovalSnapshots,
  type MuseApprovalStreamMetadata,
  buildMuseApprovalDecideParams,
  extractMuseApprovalRecord,
  isTerminalMuseApproval,
  mapMuseApproval
} from '@shared/museApprovals'
import { getBotHubBridge } from './electronBridge'
import {
  AdapterError,
  type AdapterEvent,
  type AdapterListener,
  type ApprovalDecision,
  type ConnectionStatus,
  type IncomingMessage,
  type MuseApproval,
  type MuseConnector,
  type OutgoingMessage,
  type PlatformAccount,
  type PlatformAdapter,
  type SendReceipt,
  type Unsubscribe,
  type MuseOptionWidget,
  type AgentActivity
} from '../types'

/**
 * Real Meta Muse adapter.
 *
 * Drives https://muse.ai inside an Electron WebContentsView (one persist
 * partition per account) and calls the page gateway `sendRequest` when the
 * hook finds it; otherwise falls back to DOM automation for chat.stream.
 *
 * In plain browser (`npm run dev:web`) there is no bridge — methods throw
 * `unsupported` so the UI can fall back to mock via BOTHUB_USE_MOCK_MUSE.
 */

function mapConnector(raw: unknown, index: number): MuseConnector {
  const r = (raw ?? {}) as Record<string, unknown>
  const state = typeof r['state'] === 'string' ? r['state'].toLowerCase() : ''
  const connected = Boolean(
    r['connected'] ??
      r['is_connected'] ??
      (r['status'] === 'connected' || state === 'connected' || state === 'active')
  )
  return {
    id: String(r['id'] ?? r['connector_id'] ?? `connector-${index}`),
    name: String(r['name'] ?? r['title'] ?? r['id'] ?? `Connector ${index + 1}`),
    connected,
    description: typeof r['description'] === 'string' ? r['description'] : undefined,
    raw
  }
}

const FILE_REF_BYTES = 0xa0_0000 // 10 MiB — official HatchAttachments non-image gate
const VIDEO_REF_BYTES = 0x3c0_0000 // 60 MiB video

function needsFileRef(mime: string, size: number): boolean {
  const m = mime.toLowerCase()
  if (m.startsWith('image/')) return false
  if (m.startsWith('video/')) return size >= VIDEO_REF_BYTES
  return size >= FILE_REF_BYTES
}

/** Map BotHub attachments → Muse chat.stream items (official HatchAttachments shapes). */
async function museChatItemsFromAttachments(
  muse: ReturnType<MuseAdapter['bridge']>,
  accountId: string,
  attachments: OutgoingMessage['attachments']
): Promise<Array<Record<string, unknown>>> {
  if (!attachments?.length) return []
  const items: Array<Record<string, unknown>> = []
  for (const a of attachments) {
    if (!a.dataBase64) continue
    const mime = a.mimeType || 'application/octet-stream'
    const filename = a.name || 'file'
    const size = typeof a.size === 'number' ? a.size : Math.floor((a.dataBase64.length * 3) / 4)
    if (mime.startsWith('image/')) {
      items.push({ type: 'image', mime_type: mime, data_base64: a.dataBase64, filename })
    } else if (needsFileRef(mime, size) && muse.uploadWorkspaceFile) {
      const uploaded = await muse.uploadWorkspaceFile(accountId, {
        filename,
        mimeType: mime,
        dataBase64: a.dataBase64
      })
      items.push({
        type: 'file_ref',
        mime_type: mime,
        path: uploaded.path,
        filename: uploaded.filename
      })
    } else {
      items.push({ type: 'file', mime_type: mime, data_base64: a.dataBase64, filename })
    }
  }
  return items
}

type MuseClientEvent = MuseMainEvent & MuseApprovalStreamMetadata & { sendId?: string; sessionId?: string }

interface ApprovalState {
  ledger: MuseApprovalSnapshots
  version: number
  read?: Promise<MuseApproval[]>
}

interface PendingSend {
  id: string
  message: OutgoingMessage
  accepted: boolean
  delivered: boolean
  sessionId?: string
}

export class MuseAdapter implements PlatformAdapter {
  readonly id = 'meta-muse' as const
  readonly name = 'Meta Muse'

  private readonly accounts = new Map<string, PlatformAccount>()
  private readonly statuses = new Map<string, ConnectionStatus>()
  private readonly listeners = new Set<AdapterListener>()
  private readonly pendingApprovals = new Map<string, MuseApproval[]>()
  private readonly approvalStates = new Map<string, ApprovalState>()
  private readonly sends = new Map<string, PendingSend>()
  private readonly activeSends = new Map<string, PendingSend>()
  private readonly approvalPolling = new Map<string, { timer: ReturnType<typeof setInterval>; users: number }>()
  private bridgeUnsub: Unsubscribe | null = null

  constructor() {
    this.bindBridgeEvents()
  }

  private bridge() {
    const b = getBotHubBridge()
    if (!b?.muse) throw new AdapterError('unsupported', 'Muse needs the Electron app (npm run dev).')
    return b.muse
  }

  private bindBridgeEvents(): void {
    const b = getBotHubBridge()
    if (!b?.muse || this.bridgeUnsub) return
    this.bridgeUnsub = b.muse.onEvent((event) => this.handleMainEvent(event))
  }

  private handleMainEvent(event: MuseClientEvent): void {
    switch (event.type) {
      case 'status': {
        const s = event.status
        const busy = this.activeSends.has(s.accountId)
        const status: ConnectionStatus = !s.signedIn
          ? 'offline'
          : s.pendingApprovals > 0
            ? 'attention'
            : s.ready && !busy
              ? 'online'
              : 'busy'
        this.setStatus(
          s.accountId,
          s.phase && s.phase !== 'ready' && s.signedIn ? 'busy' : status,
          s.phase && s.phase !== 'ready' ? s.phaseDetail : s.hook === 'none' ? 'Waiting for muse.ai gateway…' : undefined
        )
        break
      }
      case 'login': {
        if (!event.signedIn) this.clearApprovals(event.accountId)
        this.emit({
          type: 'login',
          accountId: event.accountId,
          signedIn: event.signedIn,
          handle: event.handle,
          displayName: event.displayName,
          windowClosed: event.windowClosed
        })
        this.setStatus(event.accountId, event.signedIn ? 'online' : 'offline')
        break
      }
      case 'approvals':
        this.applyApprovals(event.accountId, this.approvalState(event.accountId), event.pending, event)
        break
      case 'sent': {
        const send = this.correlatedSend(event)
        if (send && !send.accepted) {
          send.accepted = true
          send.sessionId = event.sessionId ?? send.sessionId
          try {
            send.message.onAccepted?.()
          } catch (error) {
            console.error('[muse adapter] acceptance callback failed', error)
          }
        }
        break
      }
      case 'stream': {
        const send = this.correlatedSend(event)
        if (event.sendId && !send) break
        const widgets = event.widgets as MuseOptionWidget[] | undefined
        const tools = event.tools as import('../types').MuseToolCall[] | undefined
        const media = event.media as import('../types').MuseMediaPart[] | undefined
        const richWidgets = (event as { richWidgets?: import('../types').MuseRichWidget[] }).richWidgets
        if (!event.done) {
          this.emit({
            type: 'typing',
            conversationId: event.conversationId ?? event.accountId,
            accountId: event.accountId,
            sessionId: event.sessionId ?? send?.sessionId,
            isTyping: true
          })
          if (event.text || widgets?.length || richWidgets?.length || tools?.length || media?.length) {
            this.emit({
              type: 'message_delta',
              messageId: event.messageId,
              conversationId: event.conversationId ?? event.accountId,
              accountId: event.accountId,
              sessionId: event.sessionId ?? send?.sessionId,
              text: event.text || '',
              widgets,
              richWidgets,
              tools,
              media
            })
          }
          this.setStatus(event.accountId, 'busy')
        } else {
          const conversationId = event.conversationId ?? event.accountId
          this.emit({
            type: 'typing',
            conversationId,
            accountId: event.accountId,
            sessionId: event.sessionId ?? send?.sessionId,
            isTyping: false
          })
          if (event.text || widgets?.length || richWidgets?.length || tools?.length || media?.length) {
            if (send) send.delivered = true
            const message: IncomingMessage & {
              widgets?: MuseOptionWidget[]
              richWidgets?: import('../types').MuseRichWidget[]
              tools?: import('../types').MuseToolCall[]
              media?: import('../types').MuseMediaPart[]
            } = {
              id: event.messageId,
              conversationId,
              accountId: event.accountId,
              sessionId: event.sessionId ?? send?.sessionId,
              text: event.text || '',
              createdAt: Date.now(),
              widgets,
              richWidgets,
              tools,
              media
            }
            this.emit({ type: 'message', message })
          }
          if (!send && !this.activeSends.has(event.accountId)) {
            const pending = this.pendingApprovals.get(event.accountId) ?? []
            this.setStatus(event.accountId, pending.length ? 'attention' : 'online')
          }
        }
        break
      }
      case 'activity': {
        const activity: AgentActivity = {
          code: event.activityCode,
          text: event.activityText ?? null,
          emoji: event.activityEmoji ?? null,
          agentId: event.agentId ?? null,
          subagents: event.subagents ?? 0,
          busy: event.busy,
          ctaLabel: event.ctaLabel
        }
        this.emit({ type: 'activity', accountId: event.accountId, sessionId: event.sessionId, activity })
        const needsApproval =
          activity.code === 'needs_approval' ||
          /approval|confirm|permission/i.test(activity.code) ||
          /approval|批准|审批/i.test(activity.text ?? '')
        if (needsApproval) {
          void this.listApprovals(event.accountId).catch(() => {})
          this.setStatus(event.accountId, 'attention')
        } else if (event.busy) {
          this.setStatus(event.accountId, 'busy')
        } else {
          const pending = this.pendingApprovals.get(event.accountId) ?? []
          this.setStatus(event.accountId, pending.length ? 'attention' : 'online')
        }
        break
      }
    }
  }

  async listAccounts(): Promise<PlatformAccount[]> {
    return [...this.accounts.values()]
  }

  /** Register a BotHub-side account (after user starts login). */
  upsertAccount(account: PlatformAccount): void {
    this.accounts.set(account.id, account)
    if (!this.statuses.has(account.id)) this.statuses.set(account.id, 'offline')
  }

  async ensureSession(accountId: string, botId = 'muse'): Promise<void> {
    this.bindBridgeEvents()
    if (!this.accounts.has(accountId)) {
      this.upsertAccount({
        id: accountId,
        platformId: 'meta-muse',
        displayName: 'Muse account',
        handle: accountId
      })
    }
    const status = await this.bridge().ensure({ botId, accountId })
    this.setStatus(
      accountId,
      status.signedIn ? (status.pendingApprovals > 0 ? 'attention' : 'online') : 'offline'
    )
  }

  async connect(accountId: string): Promise<ConnectionStatus> {
    await this.ensureSession(accountId)
    return this.getStatus(accountId)
  }

  async openLogin(accountId: string, botId = 'muse'): Promise<ConnectionStatus> {
    this.bindBridgeEvents()
    if (!this.accounts.has(accountId)) {
      this.upsertAccount({
        id: accountId,
        platformId: 'meta-muse',
        displayName: 'Muse account',
        handle: accountId
      })
    }
    const status = await this.bridge().openLogin({ botId, accountId })
    this.setStatus(
      accountId,
      status.signedIn ? (status.pendingApprovals > 0 ? 'attention' : 'online') : 'offline',
      status.signedIn ? undefined : '在弹出的窗口里完成 Muse 登录'
    )
    return this.getStatus(accountId)
  }

  async cancelLogin(accountId: string): Promise<void> {
    await this.bridge().cancelLogin(accountId)
    this.accounts.delete(accountId)
    this.statuses.delete(accountId)
    this.clearApprovals(accountId)
  }

  async disconnect(accountId: string): Promise<void> {
    this.setStatus(accountId, 'offline')
  }

  private correlatedSend(event: { accountId: string; conversationId?: string; sendId?: string }): PendingSend | undefined {
    const send = event.sendId && this.sends.get(event.sendId)
    if (!send || send.message.accountId !== event.accountId || send.message.conversationId !== event.conversationId) return
    return send
  }

  private pollApprovals(accountId: string): () => void {
    let poll = this.approvalPolling.get(accountId)
    if (!poll) {
      poll = { users: 0, timer: setInterval(() => void this.listApprovals(accountId).catch(() => undefined), 3000) }
      this.approvalPolling.set(accountId, poll)
    }
    const active = poll
    active.users++
    return () => {
      if (--active.users === 0) {
        clearInterval(active.timer)
        this.approvalPolling.delete(accountId)
      }
    }
  }

  async sendMessage(message: OutgoingMessage): Promise<SendReceipt> {
    message.signal?.throwIfAborted()
    const { accountId, conversationId } = message
    const status = this.getStatus(accountId)
    if (status === 'offline' || status === 'error') {
      throw new AdapterError('not-connected', 'Sign in to muse.ai first (open the web session).')
    }
    this.bindBridgeEvents()
    const muse = this.bridge()
    const id = createId('mm_out')
    const send: PendingSend = { id, message, accepted: false, delivered: false, sessionId: message.sessionId }
    this.sends.set(id, send)
    this.activeSends.set(accountId, send)
    this.setStatus(accountId, 'busy')
    const stopPoll = this.pollApprovals(accountId)
    const typing = (isTyping: boolean) => this.emit({ type: 'typing', conversationId, accountId, sessionId: send.sessionId, isTyping })
    const isCurrent = () => this.activeSends.get(accountId) === send
    let dispatched = false
    const requestStop = () => {
      if (!dispatched) return
      const request = { accountId, method: 'chat.stop_turn', sendId: id }
      void muse.rpc(request).catch(() => undefined)
    }
    message.signal?.addEventListener('abort', requestStop, { once: true })
    typing(true)
    try {
      const attachments = await museChatItemsFromAttachments(muse, accountId, message.attachments)
      message.signal?.throwIfAborted()
      if (!isCurrent()) throw new Error('Muse turn superseded')
      const request = {
        accountId, method: 'chat.stream', conversationId, sendId: id,
        params: {
          ...(message.sessionId !== undefined ? { session_id: message.sessionId } : {}),
          items: [...(message.text.trim() ? [{ type: 'text', text: message.text }] : []), ...attachments]
        }
      }
      dispatched = true
      const result = await muse.rpc(request).catch((error) => {
        if (error instanceof Error && /Muse turn timed out/.test(error.message)) throw new AdapterError('timeout', error.message)
        throw error
      })
      message.signal?.throwIfAborted()
      const resultObj = result && typeof result === 'object' ? result as Record<string, unknown> : null
      const receipt: SendReceipt = {
        messageId: id,
        acceptedAt: Date.now(),
        sessionId: typeof resultObj?.['session_id'] === 'string' ? resultObj['session_id'] : send.sessionId
      }
      send.sessionId = receipt.sessionId
      if (!send.delivered) {
        const text = extractText(result)
        if (!text) throw new AdapterError('no-reply', 'Muse 已收到消息，但等待超时仍没有回复')
        this.emit({
          type: 'message',
          message: {
            id: typeof resultObj?.['assistant_message_id'] === 'string' ? resultObj['assistant_message_id'] : createId('mm_in'),
            conversationId, accountId, sessionId: receipt.sessionId, text, createdAt: Date.now(), replyTo: receipt.messageId
          }
        })
      }
      if (isCurrent()) this.setStatus(accountId, this.pendingApprovals.get(accountId)?.length ? 'attention' : 'online')
      return receipt
    } catch (error) {
      if (isCurrent()) {
        const pending = this.pendingApprovals.get(accountId) ?? []
        const next = pending.length ? 'attention' : statusAfterSendFailure(error)
        this.setStatus(accountId, next, next === 'error' ? (error instanceof Error ? error.message : String(error)) : undefined)
        if (!message.signal?.aborted) void this.listApprovals(accountId).catch(() => undefined)
      }
      throw error
    } finally {
      stopPoll()
      this.sends.delete(id)
      message.signal?.removeEventListener('abort', requestStop)
      if (isCurrent()) {
        this.activeSends.delete(accountId)
        typing(false)
      } else if (this.activeSends.get(accountId)?.message.conversationId !== conversationId) {
        typing(false)
      }
    }
  }

  async selectOptionWidget(args: {
    accountId: string
    conversationId: string
    hostMessageId: string
    widget: MuseOptionWidget
    selectedText: string
    optionIndex: number
  }): Promise<void> {
    this.bindBridgeEvents()
    this.setStatus(args.accountId, 'busy')
    this.emit({
      type: 'typing',
      conversationId: args.conversationId,
      accountId: args.accountId,
      isTyping: true
    })
    // Optimistic local user bubble is handled by the store; persist + stream here.
    try {
      await this.bridge().selectOption({
        accountId: args.accountId,
        conversationId: args.conversationId,
        hostMessageId: args.hostMessageId,
        selectedText: args.selectedText,
        optionIndex: args.optionIndex,
        widget: args.widget
      })
      const pending = this.pendingApprovals.get(args.accountId) ?? []
      this.setStatus(args.accountId, pending.length ? 'attention' : 'online')
    } catch (error) {
      this.emit({
        type: 'typing',
        conversationId: args.conversationId,
        accountId: args.accountId,
        isTyping: false
      })
      this.setStatus(args.accountId, 'error', error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  private approvalState(accountId: string): ApprovalState {
    let state = this.approvalStates.get(accountId)
    if (!state) {
      state = { ledger: new MuseApprovalSnapshots(), version: 0 }
      this.approvalStates.set(accountId, state)
    }
    return state
  }

  private clearApprovals(accountId: string): void {
    this.pendingApprovals.delete(accountId)
    this.approvalStates.delete(accountId)
  }

  private applyApprovals(accountId: string, state: ApprovalState, raw: unknown, metadata: MuseApprovalStreamMetadata): MuseApproval[] {
    if (this.approvalStates.get(accountId) !== state ||
        (metadata.approvalVersion !== undefined && metadata.approvalVersion <= state.version)) {
      return this.pendingApprovals.get(accountId) ?? []
    }
    if (metadata.approvalVersion !== undefined) state.version = metadata.approvalVersion
    const pending = state.ledger.apply(raw, metadata.terminalApprovalIds).map(mapMuseApproval)
    this.pendingApprovals.set(accountId, pending)
    this.emit({ type: 'approvals', accountId, pending })
    const status = this.getStatus(accountId)
    if (pending.length > 0) this.setStatus(accountId, 'attention')
    else if (status === 'attention' || status === 'error') this.setStatus(accountId, this.activeSends.has(accountId) ? 'busy' : 'online')
    return pending
  }

  async listApprovals(accountId: string): Promise<MuseApproval[]> {
    if (this.getStatus(accountId) === 'offline') return []
    const state = this.approvalState(accountId)
    if (state.read) return state.read
    const versionAtStart = state.version
    const read = (async () => {
      try {
        const raw = await this.bridge().rpc({ accountId, method: 'egress.approvals', params: {} })
        const metadata = raw && typeof raw === 'object' ? raw as MuseApprovalStreamMetadata : {}
        if (metadata.approvalVersion === undefined && state.version !== versionAtStart) return this.pendingApprovals.get(accountId) ?? []
        return this.applyApprovals(accountId, state, raw, metadata)
      } catch {
        return this.pendingApprovals.get(accountId) ?? []
      }
    })().finally(() => {
      if (state.read === read) state.read = undefined
    })
    state.read = read
    return read
  }

  async decideApproval(
    accountId: string,
    approvalId: string,
    decision: ApprovalDecision | string,
    opts?: { scope?: string; opensUrl?: string }
  ): Promise<void> {
    const state = this.approvalState(accountId)
    if (state.ledger.isResolved(approvalId)) return
    let approval = (this.pendingApprovals.get(accountId) ?? []).find((a) => a.id === approvalId)
    if (!approval) {
      try {
        const detail = await this.bridge().rpc({
          accountId,
          method: 'egress.approval',
          params: { approval_id: approvalId }
        })
        const record = extractMuseApprovalRecord(detail)
        if (record && isTerminalMuseApproval(record)) {
          state.ledger.resolve(approvalId)
          this.applyApprovals(accountId, state, state.ledger.pending, {})
          return
        }
        if (record) approval = mapMuseApproval(record)
      } catch {
        /* fallback to default scope resolution */
      }
    }

    if (this.approvalStates.get(accountId) !== state || state.ledger.isResolved(approvalId)) return

    const matchedOption = approval?.decisionOptionDetails?.find(
      (o) => o.kind === decision && (!opts?.scope || o.scope === opts.scope)
    )
    const opensUrl = opts?.opensUrl ?? matchedOption?.opensUrl
    if (opensUrl) {
      await this.bridge().openHttps?.(opensUrl)
      if (!KNOWN_APPROVAL_DECISIONS.has(decision as ApprovalDecision)) {
        await this.listApprovals(accountId)
        return
      }
    }

    const params = buildMuseApprovalDecideParams(approval, approvalId, decision, opts?.scope)
    const result = await this.bridge().rpc({ accountId, method: 'egress.approval.decide', params })
    const verdict = result as { ok?: boolean; success?: boolean } | undefined
    if (verdict?.ok === false || verdict?.success === false) throw new Error('Muse rejected the approval decision')
    if (this.approvalStates.get(accountId) === state) {
      state.read = undefined
      state.ledger.resolve(approvalId)
      this.applyApprovals(accountId, state, state.ledger.pending, {})
      await this.listApprovals(accountId)
    }
  }

  async listConnectors(accountId: string): Promise<MuseConnector[]> {
    const status = this.getStatus(accountId)
    if (status === 'offline' || status === 'error') return []
    let raw: unknown
    try {
      raw = await this.bridge().rpc({ accountId, method: 'connectors.list', params: {} })
    } catch (error) {
      console.warn('[muse] listConnectors', error)
      return []
    }
    if (Array.isArray(raw)) return raw.map(mapConnector)
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>
      const list = (obj['connectors'] as unknown[]) || (obj['items'] as unknown[]) || []
      if (Array.isArray(list)) return list.map(mapConnector)
    }
    return []
  }

  subscribe(listener: AdapterListener): Unsubscribe {
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

  getStatus(accountId: string): ConnectionStatus {
    return this.statuses.get(accountId) ?? 'offline'
  }

  private setStatus(accountId: string, status: ConnectionStatus, detail?: string): void {
    if (this.statuses.get(accountId) === status && detail === undefined) return
    this.statuses.set(accountId, status)
    this.emit({ type: 'status', accountId, status, detail })
  }

  private emit(event: AdapterEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[muse adapter] listener failed', error)
      }
    }
  }
}

function extractText(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  if (typeof result !== 'object') return String(result)
  const r = result as Record<string, unknown>
  for (const key of ['text', 'display_text', 'message', 'content', 'reply']) {
    if (typeof r[key] === 'string' && (r[key] as string).trim()) return r[key] as string
  }
  if (r['ok'] === true && r['mode'] === 'dom') {
    if (typeof r['reply'] === 'string' && (r['reply'] as string).trim()) return r['reply'] as string
    return 'Message submitted in the muse.ai page (DOM fallback). Watch the web session for the streaming reply.'
  }
  // Ack-only shape means the session manager could not collect an assistant reply yet.
  if (typeof r['message_id'] === 'string' && typeof r['session_id'] === 'string') {
    return ''
  }
  return ''
}

export function createMuseAdapter(): MuseAdapter {
  return new MuseAdapter()
}
