/**
 * Muse chat over the native gateway.
 *
 * Wire behaviour (verified against the live gateway):
 * - `chat.stream` only returns the ack `{message_id, session_id, channel, …}` and ends.
 * - All chat traffic arrives on a long-lived `chat.subscribe` stream as
 *   `{type:"event", event:"<name>", seq, ts_ms, payload:{…}}`.
 * - `delta.message_start` → `delta.text_append` (payload.text) → `delta.message_done`
 *   (payload.status="completed", payload.transcript.messages[].content[].text).
 * - Text deltas are only sent when the client advertises `delta_stream`.
 * - Long turns emit multiple assistant message_ids; settle only when agent
 *   activity leaves the busy set (or hard timeout), never 4s after first done.
 */
import { EventEmitter } from 'node:events'
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  assistantMessageId,
  assistantTextFromPayload,
  chatAckIds,
  chatAckSessionId,
  chatEvent,
  chatEventDeviceId,
  chatParentMessageId,
  chatPlaceholderText,
  chatUserMessageId,
  historyAssistantsAfterTurn,
  isMuseIdleActivity,
  isMuseToolEvent,
  mergeMonotonic,
  mergeRichWidgets,
  museEventSessionId,
  parseAgentStatus,
  parseMediaParts,
  parseOptionWidgets,
  parseRichWidgets,
  parseToolCall,
  remoteToolId,
  type HistoryRow,
  type MuseChatEvent,
  type MuseMediaPart,
  type MuseOptionWidget,
  type MuseRichWidget,
  type MuseToolCall,
  type RemoteCardType
} from './chatExtractors'
import { MuseGatewayError, type MuseNativeGateway, type SubscriptionHandle } from './gateway'
import { abortable } from './lifecycle'

export {
  historyAssistants,
  historyAssistantsAfterTurn,
  isMuseBusyActivity,
  isMuseIdleActivity,
  mergeMonotonic,
  museEventSessionId,
  MUSE_BUSY_ACTIVITY,
  parseAgentStatus,
  parseHistoryTranscript,
  parseMediaParts,
  parseMuseTimestampMs,
  parseOptionWidgets,
  parseRichWidgets,
  parseToolCall,
  transcriptText
} from './chatExtractors'
export type {
  MuseAgentActivity,
  MuseChatEvent,
  MuseHistoryMessage,
  MuseMediaPart,
  MuseOptionWidget,
  MuseRichWidget,
  MuseToolCall
} from './chatExtractors'

/** Abort reason for a turn replaced by a newer send: stop locally, keep it running server-side. */
export const MUSE_STREAM_SUPERSEDED = 'superseded'
export const MUSE_STREAM_STOPPED = 'stopped'

export function isMuseStop(signal: AbortSignal): boolean {
  return signal.reason === MUSE_STREAM_STOPPED ||
    (signal.reason instanceof DOMException && signal.reason.name === 'AbortError')
}

export function createMuseTurnDeadline(opts: { signal?: AbortSignal; timeoutMs?: number }): {
  signal: AbortSignal
  dispose(): void
} {
  const controller = new AbortController()
  const onAbort = () => controller.abort(opts.signal?.reason)
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  if (opts.signal?.aborted) onAbort()
  const timer = setTimeout(() => controller.abort(new MuseGatewayError('Muse turn timed out', 'timeout')), opts.timeoutMs ?? 600_000)
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }
}

/** Client capabilities the web client advertises (`delta_stream` enables text deltas). */
export const MUSE_CHAT_CAPABILITIES = [
  'hotel_results',
  'chat_cancel',
  'delta_stream',
  'custom_reactions',
  'custom_reactions_facebook_thumbs_up_v1'
]

const REMOTE_EVENT = /^(?:delta\.)?(?:browser|computer|ui_widget)(?:[.:_]|$)/i

/** Debug: BOTARK_MUSE_CAPTURE=<file> appends every decrypted chat.subscribe event as NDJSON. */
export function captureLine(e: unknown): string {
  // Long strings (base64 frames, transcripts) are cut so field names stay readable.
  return JSON.stringify(e, (_k, v) => (typeof v === 'string' && v.length > 2000 ? `${v.slice(0, 200)}…[${v.length} chars]` : v))
}

function captureMuseEvent(e: unknown): void {
  const file = process.env['BOTARK_MUSE_CAPTURE']
  if (!file) return
  try {
    // shortcut: sync append, fine for an opt-in debug capture; never enable by default.
    appendFileSync(file, captureLine(e) + '\n')
  } catch {
    /* capture must never break chat */
  }
}

/**
 * One `chat.subscribe` per connection; re-subscribes after every reconnect.
 * Emits `event` (MuseChatEvent).
 */
export class MuseChatChannel extends EventEmitter {
  private handle: SubscriptionHandle | null = null
  private pending: SubscriptionHandle | null = null
  private opening: Promise<void> | null = null
  private retryTimer?: ReturnType<typeof setTimeout>
  private readonly lifetime = new AbortController()

  private readonly onPhase = (phase: string): void => {
    if (phase === 'ready') void this.ensure().catch(() => undefined)
  }

  constructor(private readonly gw: MuseNativeGateway) {
    super()
    this.setMaxListeners(50)
    gw.on('phase', this.onPhase)
  }

  async ensure(): Promise<void> {
    const { signal } = this.lifetime
    signal.throwIfAborted()
    if (this.handle) return
    if (this.opening) return this.opening
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const opening = abortable(signal, async () => {
      const h = await this.gw.subscribe('chat.subscribe', { capabilities: MUSE_CHAT_CAPABILITIES }, (raw) => {
        captureMuseEvent(raw)
        const event = chatEvent(raw)
        if (!signal.aborted && event) this.emit('event', event)
      }, signal)
      if (signal.aborted) {
        h.cancel('disposed')
        signal.throwIfAborted()
      }
      this.pending = h
      try {
        await h.ack
        signal.throwIfAborted()
        this.handle = h
        void h.done.then(() => this.onEnded(h), () => this.onEnded(h))
        this.emit('resumed')
      } catch (err) {
        h.cancel('subscription setup failed')
        throw err
      } finally {
        if (this.pending === h) this.pending = null
      }
    }).finally(() => {
      if (this.opening === opening) this.opening = null
    })
    this.opening = opening
    void opening.catch(() => this.scheduleRetry(1500))
    return opening
  }

  private onEnded(h: SubscriptionHandle): void {
    if (this.handle !== h) return
    this.handle = null
    this.emit('ended')
    this.scheduleRetry(0)
  }

  private scheduleRetry(ms: number): void {
    if (this.lifetime.signal.aborted || this.handle || this.retryTimer || !this.gw.isReady()) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (this.gw.isReady()) void this.ensure().catch(() => undefined)
    }, ms)
  }

  stop(): void {
    this.lifetime.abort(new MuseGatewayError('chat channel disposed', 'closed'))
    this.gw.off('phase', this.onPhase)
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const handle = this.handle
    this.handle = null
    handle?.cancel('disposed')
    this.pending?.cancel('disposed')
    this.pending = null
    this.removeAllListeners()
  }
}

export interface ChatStreamUpdate {
  /** Muse assistant message id (stable for one bubble). */
  messageId: string
  /** Full text so far. */
  text: string
  done: boolean
  /** Option chips (Kai/Juno) when present on the message. */
  widgets?: MuseOptionWidget[]
  richWidgets?: MuseRichWidget[]
  tools?: MuseToolCall[]
  media?: MuseMediaPart[]
}

export interface ChatStreamResult {
  ack: Record<string, unknown>
  sessionId?: string
  assistantMessageIds: string[]
  text: string
  eventCounts: Record<string, number>
  widgetsByMessageId: Record<string, MuseOptionWidget[]>
  richWidgetsByMessageId: Record<string, MuseRichWidget[]>
}

export interface MuseChatItem {
  type: 'text' | 'image' | 'file' | 'file_ref'
  text?: string
  mime_type?: string
  data_base64?: string
  filename?: string
  path?: string
}

export interface StreamChatInput {
  text: string
  nodeId: string
  sessionId?: string
  capabilities?: string[]
  /** Extra chat.stream items (images/files) after the text item. */
  items?: MuseChatItem[]
  /** Origin metadata for option-widget taps. */
  messageOrigin?: Record<string, unknown>
  /** Called once the server acknowledged this user message. */
  onAck?: (sessionId?: string) => void
  onSessionId?: (sessionId: string) => void
  /** Check that a delayed Stop still owns the session. */
  canCancel?: () => boolean
  beforeSend?: (signal: AbortSignal) => Promise<unknown>
}

/** Build chat.stream `items` from text + optional attachment items. */
export function buildChatStreamItems(text: string, extra?: MuseChatItem[]): MuseChatItem[] {
  const items: MuseChatItem[] = []
  const trimmed = text.trim()
  if (trimmed) items.push({ type: 'text', text: trimmed })
  if (extra?.length) {
    for (const it of extra) {
      if (!it || !it.type) continue
      items.push(it)
    }
  }
  if (!items.length) items.push({ type: 'text', text: text || '' })
  return items
}

/**
 * Send one user turn and stream the assistant reply(ies) until the agent leaves
 * the busy activity set (debounced) or the hard timeout fires.
 *
 * Does **not** end ~4s after the first `message_done` — long jobs emit a second
 * (or Nth) bubble with a new `message_id` after tools finish.
 */
export async function streamChat(
  gw: MuseNativeGateway,
  channel: MuseChatChannel,
  input: StreamChatInput,
  onUpdate: (u: ChatStreamUpdate) => void,
  opts: { timeoutMs?: number; settleMs?: number; recoverMs?: number; signal?: AbortSignal; deadline?: AbortSignal } = {}
): Promise<ChatStreamResult> {
  const ownDeadline = opts.deadline ? undefined : createMuseTurnDeadline(opts)
  const signal = opts.deadline ?? ownDeadline!.signal
  const cleanup = new AbortController()
  const working = AbortSignal.any([signal, cleanup.signal])

  const settleMs = opts.settleMs ?? 1500
  const counts: Record<string, number> = {}
  const texts = new Map<string, string>()
  const liveTexts = new Map<string, { text: string; deltas: Array<{ seq: number; text: string }> }>()
  const historyTexts = new Map<string, { text: string; seq: number }>()
  const seenSequences = new Set<string>()
  const earlyEvents: Array<{ event: MuseChatEvent; scoped: boolean }> = []
  const widgets = new Map<string, MuseOptionWidget[]>()
  const richWidgets = new Map<string, MuseRichWidget[]>()
  const remoteTools = new Map<string, RemoteCardType>()
  const toolMessages = new Map<string, string>()
  const tools = new Map<string, MuseToolCall[]>()
  const media = new Map<string, MuseMediaPart[]>()
  const pendingMedia: MuseMediaPart[] = []
  let pendingRichWidgets: MuseRichWidget[] = []
  let pendingWidgetSeq = 0
  const order: string[] = []
  const doneIds = new Set<string>()
  const finalTextIds = new Set<string>()
  const richWidgetSequences = new Map<string, number>()
  let sessionId = input.sessionId ?? ''
  let ackUserMessageId = ''
  const turnStartedAtMs = Date.now()
  let started = false
  let sending = false
  let dispatched = false
  let sharedTurnMatches = true
  let lastActivity = ''
  let settle!: () => void
  let fail!: (e: Error) => void
  const finished = new Promise<void>((a, b) => {
    settle = a
    fail = b
  })
  void finished.catch(() => undefined)
  let settleTimer: ReturnType<typeof setTimeout> | null = null

  const clearSettle = (): void => {
    if (settleTimer) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
  }

  /** Arm settle only when activity is non-busy and we have at least one bubble. */
  const armSettleIfIdle = (): void => {
    clearSettle()
    if (!started) return
    if (lastActivity && !isMuseIdleActivity(lastActivity)) return
    if (order.length === 0 && doneIds.size === 0) return
    settleTimer = setTimeout(() => {
      settleTimer = null
      settle()
    }, settleMs)
  }

  const mergeMediaList = (id: string, parts: MuseMediaPart[]): boolean => {
    if (!parts.length) return false
    const prev = media.get(id) ?? []
    const seen = new Set(prev.map((x) => x.path))
    const merged = [...prev]
    let added = false
    for (const part of parts) {
      if (seen.has(part.path)) continue
      seen.add(part.path)
      merged.push(part)
      added = true
    }
    if (added) media.set(id, merged)
    return added
  }

  const ensureBubble = (id: string): void => {
    if (!id) return
    if (!texts.has(id)) {
      texts.set(id, '')
      order.push(id)
    }
    if (pendingMedia.length > 0) {
      const drained = pendingMedia.splice(0, pendingMedia.length)
      mergeMediaList(id, drained)
    }
    if (pendingRichWidgets.length) {
      richWidgets.set(id, mergeRichWidgets(richWidgets.get(id), pendingRichWidgets))
      if (pendingWidgetSeq) richWidgetSequences.set(id, Math.max(pendingWidgetSeq, richWidgetSequences.get(id) ?? 0))
      pendingRichWidgets = []
      pendingWidgetSeq = 0
    }
  }

  const pushUpdate = (id: string, done: boolean): void => {
    if (working.aborted) return
    onUpdate({
      messageId: id,
      text: texts.get(id) ?? '',
      done,
      widgets: widgets.get(id),
      richWidgets: richWidgets.get(id),
      tools: tools.get(id),
      media: media.get(id)
    })
  }

  const mine = (p: Record<string, unknown>): boolean => {
    const session = museEventSessionId(p)
    if (session && sessionId && session !== sessionId) return false
    const device = chatEventDeviceId(p)
    return Boolean(sessionId) || !device || device === input.nodeId
  }

  const ownsUserMessage = (p: Record<string, unknown>): boolean => Boolean(ackUserMessageId) &&
    chatUserMessageId(p) === ackUserMessageId

  const appendLiveText = (id: string, chunk: string, seq: number): void => {
    const live = liveTexts.get(id) ?? { text: '', deltas: [] }
    live.text += chunk
    live.deltas.push({ seq, text: chunk })
    liveTexts.set(id, live)
    const history = historyTexts.get(id)
    // A sequenced snapshot covers all deltas through that sequence. When no
    // sequence is available, keep both candidates until the completed text arrives.
    if (history?.seq && seq > history.seq) {
      history.text += chunk
      history.seq = seq
    }
    texts.set(id, history?.seq ? history.text : mergeMonotonic(live.text, history?.text ?? ''))
  }

  const applyMedia = (id: string, p: Record<string, unknown>): boolean => {
    const parsed = parseMediaParts(p)
    if (!parsed.length) return false
    const target = id || order[order.length - 1] || ''
    if (!target) {
      const seen = new Set(pendingMedia.map((x) => x.path))
      for (const part of parsed) {
        if (!seen.has(part.path)) {
          seen.add(part.path)
          pendingMedia.push(part)
        }
      }
      return false
    }
    return mergeMediaList(target, parsed)
  }

  const upsertTool = (id: string, tool: MuseToolCall): void => {
    const prev = tools.get(id) ?? []
    const idx = prev.findIndex((t) => t.id === tool.id || t.name === tool.name)
    if (idx >= 0) {
      const next = [...prev]
      const previous = prev[idx]!
      next[idx] = {
        ...previous,
        ...tool,
        id: previous.id,
        name: tool.name === 'tool_call' ? previous.name : tool.name,
        toolType: tool.toolType ?? previous.toolType,
        summary: tool.summary ?? previous.summary
      }
      tools.set(id, next)
    } else {
      tools.set(id, [...prev, tool])
    }
  }

  const applyWidgets = (id: string, p: Record<string, unknown>, eventName?: string, seq = 0): boolean => {
    const parsed = parseOptionWidgets(p)
    const rich = parseRichWidgets(p, eventName, remoteTools)
    if (!parsed.length && !rich.length) return false
    const target = id || order[order.length - 1]
    if (!target) {
      pendingRichWidgets = mergeRichWidgets(pendingRichWidgets, rich)
      if (rich.length) pendingWidgetSeq = Math.max(seq, pendingWidgetSeq)
      return false
    }
    ensureBubble(target)
    if (parsed.length) widgets.set(target, parsed)
    if (rich.length) {
      const existing = richWidgets.get(target)
      const latestSeq = richWidgetSequences.get(target) ?? 0
      richWidgets.set(target, existing && seq > 0 && seq < latestSeq ? mergeRichWidgets(rich, existing) : mergeRichWidgets(existing, rich))
      if (seq > latestSeq) richWidgetSequences.set(target, seq)
    }
    return true
  }

  const completeBubble = (id: string, p: Record<string, unknown>, seq: number): void => {
    if (!id) return
    ensureBubble(id)
    if (doneIds.has(id)) {
      const changedWidgets = applyWidgets(id, p, undefined, seq)
      const addedMedia = applyMedia(id, p)
      const nextText = finalTextIds.has(id) ? '' : assistantTextFromPayload(p)
      if (nextText) {
        texts.set(id, nextText)
        finalTextIds.add(id)
      }
      if (addedMedia || nextText || changedWidgets) pushUpdate(id, true)
      return
    }
    const status = p['status']
    if (typeof status === 'string' && status && status !== 'completed' && status !== 'complete' && status !== 'done' && status !== 'finished') {
      if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'interrupted') {
        doneIds.add(id)
        applyWidgets(id, p, undefined, seq)
        applyMedia(id, p)
        pushUpdate(id, true)
        armSettleIfIdle()
      }
      return
    }
    const final = assistantTextFromPayload(p)
    if (final) {
      texts.set(id, final)
      finalTextIds.add(id)
    }
    doneIds.add(id)
    applyWidgets(id, p, undefined, seq)
    applyMedia(id, p)
    pushUpdate(id, true)
    armSettleIfIdle()
  }

  const onEvent = (e: MuseChatEvent, scoped = false): void => {
    if (working.aborted || !sending) return
    const p = e.payload
    const toolEvent = isMuseToolEvent(e.name)
    const remoteEvent = REMOTE_EVENT.test(e.name)
    const watched =
      e.name.startsWith('delta.') ||
      e.name === 'message.user' ||
      e.name === 'agent.status' ||
      e.name === 'message.assistant' ||
      toolEvent || remoteEvent ||
      /presentation|attachment|media|artifact/i.test(e.name)
    if (!watched || !mine(p)) return
    if (!started) {
      if (earlyEvents.length < 512) earlyEvents.push({ event: e, scoped })
      return
    }
    const id = assistantMessageId(p)
    const parentId = chatParentMessageId(p)
    if (e.name === 'message.user') {
      if (!scoped) {
        // An unqualified user event may belong to another session on this account.
        if (ownsUserMessage(p)) sharedTurnMatches = true
        else if (!museEventSessionId(p) || museEventSessionId(p) === sessionId) {
          sharedTurnMatches = false
          pendingMedia.length = 0
          pendingRichWidgets = []
          pendingWidgetSeq = 0
        }
      }
      if (ownsUserMessage(p) && !sessionId) {
        sessionId = museEventSessionId(p)
        if (sessionId) input.onSessionId?.(sessionId)
      }
      return
    }
    if (e.name !== 'agent.status' && !scoped && parentId && parentId !== ackUserMessageId && !texts.has(id)) return
    if (!scoped && e.name !== 'agent.status' && !sessionId && (!parentId || parentId !== ackUserMessageId)) return
    if (!scoped && !sharedTurnMatches && !texts.has(id) && (!parentId || e.name === 'agent.status')) return
    if (remoteEvent && !scoped && !museEventSessionId(p) && !parentId && (!id || !texts.has(id))) return
    if (!sessionId && e.name !== 'agent.status' && (scoped || parentId === ackUserMessageId)) {
      sessionId = museEventSessionId(p)
      if (sessionId) input.onSessionId?.(sessionId)
    }
    if (e.seq > 0) {
      const key = `${e.seq}:${e.name}:${id}`
      if (seenSequences.has(key)) return
      seenSequences.add(key)
    }
    counts[e.name] = (counts[e.name] ?? 0) + 1
    const updateWidgets = (target: string): boolean => applyWidgets(target, p, e.name, e.seq)
    if (toolEvent) {
      const toolId = remoteToolId(p, e.name)
      const target = id || (toolId ? toolMessages.get(toolId) : undefined) || order.at(-1) || ''
      if (toolId && target) toolMessages.set(toolId, target)
      updateWidgets(target)
      applyMedia(target, p)
      if (target) {
        ensureBubble(target)
        const tool = parseToolCall(e.name, p, target)
        if (tool) upsertTool(target, tool)
        pushUpdate(target, doneIds.has(target))
      }
      if (target && doneIds.has(target)) armSettleIfIdle()
      else clearSettle()
      return
    }
    switch (e.name) {
      case 'delta.message_start':
        if (!started) break
        if (!id) break
        ensureBubble(id)
        updateWidgets(id)
        clearSettle()
        pushUpdate(id, false)
        break
      case 'delta.text_append': {
        if (!id || doneIds.has(id)) break
        ensureBubble(id)
        const chunk = p['text']
        appendLiveText(id, typeof chunk === 'string' ? chunk : '', e.seq)
        pushUpdate(id, false)
        break
      }
      case 'delta.placeholder': {
        if (!started || !id) break
        ensureBubble(id)
        updateWidgets(id)
        if (!texts.get(id)) {
          const placeholder = chatPlaceholderText(p)
          if (placeholder) texts.set(id, placeholder)
        }
        clearSettle()
        pushUpdate(id, false)
        break
      }
      case 'delta.presentation': {
        if (!started) break
        const targetId = id || order[order.length - 1] || ''
        updateWidgets(targetId)
        if (targetId) {
          ensureBubble(targetId)
          applyMedia(targetId, p)
          // A file card carries its own name; its display_text is only that label.
          if (!texts.get(targetId) && !parseMediaParts(p).length) {
            const t = assistantTextFromPayload(p)
            if (t) texts.set(targetId, t)
          }
          pushUpdate(targetId, doneIds.has(targetId))
        } else {
          applyMedia('', p)
        }
        break
      }
      case 'delta.message_done':
      case 'message.assistant': {
        if (!started) break
        if (!id) break
        completeBubble(id, p, e.seq)
        break
      }
      case 'agent.status': {
        const act = parseAgentStatus(p)
        lastActivity = act.code
        if (act.busy) {
          clearSettle()
        } else if (started && (doneIds.size > 0 || order.length > 0)) {
          armSettleIfIdle()
        }
        break
      }
      default: {
        // Catch-all for presentation / attachment / media / artifact events
        if (!started) break
        const targetId = id || order[order.length - 1] || ''
        const changedWidgets = updateWidgets(targetId)
        const added = applyMedia(targetId, p)
        if ((changedWidgets || added) && targetId) {
          pushUpdate(targetId, doneIds.has(targetId))
        }
        break
      }
    }
  }

  // The gateway can drop mid-reply. The server keeps generating; after the
  // reconnect + re-subscribe, deltas resume and message_done carries the full
  // transcript, so wait for recovery instead of failing straight away.
  // Deltas emitted while the socket was down are not replayed, so once the
  // gateway is back, backfill the in-flight reply from chat.history.
  let gapTimer: ReturnType<typeof setTimeout> | null = null
  let backfilling = false
  const applyHistoryRows = (rows: HistoryRow[]): void => {
    for (const row of rows) {
      if (working.aborted) return
      if (!row.id) continue
      ensureBubble(row.id)
      const previous = texts.get(row.id) ?? ''
      const prior = historyTexts.get(row.id)
      const live = liveTexts.get(row.id)
      let seq = row.seq ?? 0
      let snapshot = row.text
      if (!row.completed && seq && snapshot && live) {
        for (const delta of live.deltas) {
          if (delta.seq <= seq) continue
          snapshot += delta.text
          seq = delta.seq
        }
      }
      if (snapshot && (!prior || !prior.seq || seq >= prior.seq)) {
        historyTexts.set(row.id, { text: mergeMonotonic(prior?.text ?? '', snapshot), seq })
      }
      const history = historyTexts.get(row.id)?.text ?? ''
      const authoritative = row.completed && row.text && (!prior?.seq || !row.seq || row.seq >= prior.seq)
      const merged = authoritative ? row.text
        : doneIds.has(row.id) ? previous : mergeMonotonic(live?.text ?? previous, history)
      if (authoritative) finalTextIds.add(row.id)
      let changed = false
      if (merged !== texts.get(row.id)) {
        texts.set(row.id, merged)
        changed = true
      }
      if (row.widgets?.length) {
        widgets.set(row.id, row.widgets)
        changed = true
      }
      if (row.richWidgets?.length) {
        const liveWidgets = richWidgets.get(row.id)
        const older = liveWidgets && row.seq && row.seq < (richWidgetSequences.get(row.id) ?? 0)
        richWidgets.set(row.id, older ? mergeRichWidgets(row.richWidgets, liveWidgets) : mergeRichWidgets(liveWidgets, row.richWidgets))
        changed = true
      }
      if (row.media?.length && mergeMediaList(row.id, row.media)) {
        changed = true
      }
      if (row.completed && !doneIds.has(row.id)) {
        doneIds.add(row.id)
        pushUpdate(row.id, true)
      } else if (changed) {
        pushUpdate(row.id, doneIds.has(row.id))
      }
    }
  }

  const clearGap = (): void => {
    if (gapTimer) {
      clearTimeout(gapTimer)
      gapTimer = null
    }
  }

  let historyRead: Promise<void> | undefined
  const recoverHistory = (): Promise<void> => {
    if (historyRead) return historyRead
    const read = recoverHistoryOnce().finally(() => {
      if (historyRead === read) historyRead = undefined
    })
    historyRead = read
    return read
  }

  const recoverHistoryOnce = async (): Promise<void> => {
    if (working.aborted || !started || !sessionId || !gw.isReady()) return
    const hist = await abortable(working, () => gw.request('chat.history', { session_id: sessionId, limit: 50 }, 5_000, working))
    if (working.aborted) return
    applyHistoryRows(historyAssistantsAfterTurn(hist, {
      ackUserMessageId,
      knownAssistantIds: new Set(order),
      turnStartedAtMs
    }))
  }

  const backfill = async (): Promise<void> => {
    if (backfilling || !started) return
    backfilling = true
    try {
      await delay(400, undefined, { signal: working })
      while (!working.aborted && gw.isReady()) {
        await recoverHistory().catch(() => undefined)
        if (working.aborted) return
        if (order.length && order.every((id) => doneIds.has(id)) && isMuseIdleActivity(lastActivity)) {
          settle()
          return
        }
        if (!order.some((id) => !doneIds.has(id)) && isMuseIdleActivity(lastActivity)) return
        await delay(2000, undefined, { signal: working })
      }
    } catch {
      /* The turn ended during the retry delay. */
    } finally {
      backfilling = false
    }
  }

  const onResumed = (): void => {
    clearGap()
    void backfill()
  }
  const onEnded = (): void => {
    if (!gapTimer) {
      gapTimer = setTimeout(() => fail(new Error('Muse gateway did not recover mid-reply')), opts.recoverMs ?? 60_000)
    }
  }
  let sendHandle: SubscriptionHandle | undefined
  let sendHandleReleased = false
  const cancelUpstream = (id: string): void => {
    if (!id || input.canCancel?.() === false) return
    void gw.request('chat.cancel', { session_id: id }, 5_000).catch(() => undefined)
  }
  const onAbort = (): void => {
    if (isMuseStop(signal) && dispatched && sessionId) cancelUpstream(sessionId)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  let ack: Record<string, unknown> = {}
  try {
    await abortable(signal, () => gw.connect())
    await abortable(signal, () => channel.ensure())
    const beforeSend = input.beforeSend
    if (beforeSend) await abortable(signal, () => beforeSend(signal))
    channel.on('event', onEvent)
    channel.on('ended', onEnded)
    channel.on('resumed', onResumed)
    const params: Record<string, unknown> = {
      items: buildChatStreamItems(input.text, input.items),
      node_id: input.nodeId,
      capabilities: input.capabilities ?? MUSE_CHAT_CAPABILITIES
    }
    if (input.sessionId) params['session_id'] = input.sessionId
    if (input.messageOrigin) params['message_origin'] = input.messageOrigin
    sending = true
    const h = await abortable(signal, async () => {
      const handle = await gw.subscribe('chat.stream', params, (raw) => {
        const event = chatEvent(raw)
        if (event) onEvent(event, true)
      }, signal, () => { dispatched = true })
      sendHandle = handle
      if (signal.aborted) releaseSendHandle(handle)
      return handle
    })
    ack = await abortable(signal, () => h.ack)
    const { sessionId: ackSession, userMessageId } = chatAckIds(ack)
    ackUserMessageId = userMessageId
    if (ack['ok'] === false || (!ackUserMessageId && !ackSession)) throw new Error('Muse did not acknowledge this send')
    if (sessionId && ackSession && ackSession !== sessionId) throw new Error('Muse acknowledged a different chat session')
    sessionId ||= ackSession
    started = true
    input.onAck?.(sessionId || undefined)
    sharedTurnMatches = !earlyEvents.some(({ event, scoped }) => !scoped && event.name === 'message.user' && mine(event.payload))
    for (const { event, scoped } of earlyEvents) onEvent(event, scoped)
    earlyEvents.length = 0
    await abortable(signal, () => Promise.all([h.done.catch(() => undefined), finished]))
    await abortable(signal, recoverHistory).catch(() => signal.throwIfAborted())
    for (const id of order) if (!doneIds.has(id)) pushUpdate(id, true)
  } catch (error) {
    if (signal.reason === MUSE_STREAM_SUPERSEDED) throw new Error('Muse turn superseded')
    if (isMuseStop(signal)) throw new DOMException('Muse turn stopped', 'AbortError')
    throw error
  } finally {
    cleanup.abort()
    signal.removeEventListener('abort', onAbort)
    ownDeadline?.dispose()
    clearSettle()
    clearGap()
    channel.off('event', onEvent)
    channel.off('ended', onEnded)
    channel.off('resumed', onResumed)
    if (sendHandle) releaseSendHandle(sendHandle)
  }

  function releaseSendHandle(handle: SubscriptionHandle): void {
    if (sendHandleReleased) return
    sendHandleReleased = true
    if (isMuseStop(signal) && !sessionId) {
      // A new session has no safe cancel target until this send's ACK arrives.
      const lateAck = AbortSignal.timeout(30_000)
      void abortable(lateAck, () => handle.ack).then((value) => {
        cancelUpstream(chatAckSessionId(value))
      }, () => undefined).finally(() => handle.cancel()).catch(() => undefined)
    } else {
      handle.cancel()
    }
  }

  const widgetsByMessageId: Record<string, MuseOptionWidget[]> = {}
  for (const [id, list] of widgets) widgetsByMessageId[id] = list
  const richWidgetsByMessageId: Record<string, MuseRichWidget[]> = {}
  for (const [id, list] of richWidgets) richWidgetsByMessageId[id] = list
  return {
    ack,
    sessionId: sessionId || undefined,
    assistantMessageIds: order,
    text: order.map((id) => texts.get(id) ?? '').filter(Boolean).join('\n\n'),
    eventCounts: counts,
    widgetsByMessageId,
    richWidgetsByMessageId
  }
}

/**
 * Persist option selection then send the chosen label as a user turn.
 */
export async function selectOptionWidget(
  gw: MuseNativeGateway,
  channel: MuseChatChannel,
  input: {
    nodeId: string
    sessionId?: string
    hostMessageId: string
    widget: MuseOptionWidget
    selectedText: string
    optionIndex: number
    onAck?: StreamChatInput['onAck']
    onSessionId?: StreamChatInput['onSessionId']
    canCancel?: StreamChatInput['canCancel']
  },
  onUpdate: (u: ChatStreamUpdate) => void,
  opts?: { timeoutMs?: number; settleMs?: number; signal?: AbortSignal; deadline?: AbortSignal }
): Promise<ChatStreamResult> {
  const mutationId = randomUUID()
  return streamChat(
    gw,
    channel,
    {
      text: input.selectedText,
      nodeId: input.nodeId,
      sessionId: input.sessionId,
      onAck: input.onAck,
      onSessionId: input.onSessionId,
      canCancel: input.canCancel,
      beforeSend: (signal) => gw.request('widgets.state.set', {
        widget_id: input.widget.widgetId,
        base_version: input.widget.baseVersion,
        mutation_id: mutationId,
        state: { selectedText: input.selectedText }
      }, undefined, signal).catch(() => undefined),
      messageOrigin: {
        kind: 'options_widget',
        widget_id: input.widget.widgetId,
        message_id: input.hostMessageId,
        option_index: input.optionIndex,
        interaction_id: randomUUID()
      }
    },
    onUpdate,
    opts
  )
}
