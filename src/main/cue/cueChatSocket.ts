/**
 * Native Cue by Manus (`wss://api.manus.im/socket.io/`) Engine.IO v4 / Socket.IO v4
 * WebSocket client for real-time Cue Agent chat and streaming updates.
 */
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { createProxyAgent } from '../muse/accountProxy'
import { CUE_CONNECT_BASE, CUE_ORIGIN, getCueCredentialRevision, loadCueTokens } from './cueAuth'
import { getOrCreateCueDeviceId } from './cueDeviceId'
import { emitCueWatchEvent } from './cueWatchManager'

export interface CueNativeReplyResult {
  sessionId: string
  messageId: string
  reply?: {
    id: string
    text: string
  }
  replies?: Array<{ id: string; text: string }>
}

export type ParsedSocketIoPacket =
  | { kind: 'open'; payload: unknown }
  | { kind: 'ping' }
  | { kind: 'pong' }
  | { kind: 'connect'; payload: unknown }
  | { kind: 'disconnect' }
  | { kind: 'connect_error'; payload: unknown }
  | { kind: 'event'; eventName: string; payload: unknown }
  | { kind: 'other'; raw: string }

interface ConnectedCueSocket {
  ws: WebSocket
  close: (error: Error) => void
  joinedSessions: Set<string>
  listeners: Set<(packet: ParsedSocketIoPacket) => void>
  closeListeners: Set<(error: Error) => void>
  completedMessages: Set<string>
}

interface SocketAttempt {
  token: string
  wsUrl: string
  ready: Promise<ConnectedCueSocket>
  close: (error: Error) => void
}

const sockets = new Map<string, SocketAttempt>()
const sessionSends = new Map<string, Promise<unknown>>()
const socketRevisions = new Map<string, symbol>()
let defaultSocketRevision = Symbol()
const socketRevision = (accountId: string) => socketRevisions.get(accountId) ?? defaultSocketRevision

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const CUE_EVENT_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** Generates a 22-character alphanumeric ID matching Cue/Manus schema (`^[A-Za-z0-9]{22}$`). */
export function createCueEventId(): string {
  const bytes = randomBytes(22)
  let out = ''
  for (let i = 0; i < 22; i += 1) {
    out += CUE_EVENT_ID_ALPHABET[bytes[i]! % CUE_EVENT_ID_ALPHABET.length]!
  }
  return out
}

function toOptionalEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.trim()) {
    const num = Number(value.trim())
    if (Number.isFinite(num)) {
      return num < 1e12 ? Math.round(num * 1000) : Math.round(num)
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function buildCueSocketUrl(opts: {
  baseUrl?: string
  deviceId: string
  locale?: string
  tz?: string
}): string {
  const rawBase = (opts.baseUrl || CUE_CONNECT_BASE).replace(/\/+$/, '')
  const parsed = new URL(rawBase)
  const wsProto = parsed.protocol === 'http:' ? 'ws:' : 'wss:'
  const params = new URLSearchParams({
    EIO: '4',
    transport: 'websocket',
    locale: opts.locale || 'zh-CN',
    tz: opts.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    clientType: 'desktop',
    clientVersion: '1.0.6',
    'x-product-name': 'manus-agents',
    deviceId: opts.deviceId
  })
  return `${wsProto}//${parsed.host}/socket.io/?${params.toString()}`
}

export function encodeSocketIoEvent(eventName: string, payload: unknown): string {
  return `42${JSON.stringify([eventName, payload])}`
}

function safeJsonParse(raw: string): unknown {
  if (!raw.trim()) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function parseSocketIoPacket(raw: string): ParsedSocketIoPacket {
  if (!raw) return { kind: 'other', raw }
  if (raw === '2' || raw.startsWith('2')) {
    return { kind: 'ping' }
  }
  if (raw === '3') {
    return { kind: 'pong' }
  }
  if (raw.startsWith('0')) {
    return { kind: 'open', payload: safeJsonParse(raw.slice(1)) }
  }
  if (raw.startsWith('40')) {
    return { kind: 'connect', payload: safeJsonParse(raw.slice(2)) }
  }
  if (raw.startsWith('41')) {
    return { kind: 'disconnect' }
  }
  if (raw.startsWith('44')) {
    return { kind: 'connect_error', payload: safeJsonParse(raw.slice(2)) }
  }
  if (raw.startsWith('42')) {
    const arrStart = raw.indexOf('[', 2)
    if (arrStart >= 2) {
      const parsed = safeJsonParse(raw.slice(arrStart))
      if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
        return { kind: 'event', eventName: parsed[0], payload: parsed[1] }
      }
    }
  }
  return { kind: 'other', raw }
}

export function stopCueChatSocket(accountId: string): void {
  if (accountId === '*') {
    socketRevisions.clear()
    defaultSocketRevision = Symbol()
    for (const entry of sockets.values()) entry.close(new Error('Cue 实时连接已关闭'))
    return
  }
  socketRevisions.set(accountId, Symbol())
  sockets.get(accountId)?.close(new Error('Cue 实时连接已关闭'))
}

async function ensureConnectedSocket(
  accountId: string,
  opts: { wsBaseUrl?: string; timeoutMs: number; isCurrent: () => boolean }
): Promise<ConnectedCueSocket> {
  const auth = await loadCueTokens(accountId)
  if (!opts.isCurrent()) throw new Error('Cue 账号或连接已更改')
  const token = auth?.accessToken?.trim()
  if (!token) {
    throw new Error('未登录 Cue，请先完成登录后再发送消息')
  }

  const deviceId = auth?.deviceId || getOrCreateCueDeviceId(accountId)
  const wsUrl = buildCueSocketUrl({
    baseUrl: opts.wsBaseUrl || auth?.baseUrl,
    deviceId
  })

  const existing = sockets.get(accountId)
  if (existing?.token === token && existing.wsUrl === wsUrl) return existing.ready
  existing?.close(new Error('Cue 实时连接已更改'))

  let resolveReady!: (socket: ConnectedCueSocket) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<ConnectedCueSocket>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  let connected: ConnectedCueSocket | undefined
  let closed = false
  let pingDeadline: ReturnType<typeof setTimeout> | undefined
  let heartbeatMs = 45_000
  const connectTimer = setTimeout(
    () => attempt.close(new Error('Cue 实时 WebSocket 连接超时')), Math.min(15_000, opts.timeoutMs)
  )
  const attempt: SocketAttempt = {
    token, wsUrl, ready,
    close(error) {
      if (closed) return
      closed = true
      if (sockets.get(accountId) === attempt) sockets.delete(accountId)
      clearTimeout(connectTimer)
      clearTimeout(pingDeadline)
      rejectReady(error)
      for (const listener of connected?.closeListeners ?? []) listener(error)
      connected?.ws.terminate()
    }
  }
  sockets.set(accountId, attempt)
  const armHeartbeat = () => {
    clearTimeout(pingDeadline)
    pingDeadline = setTimeout(() => attempt.close(new Error('Cue 实时连接心跳超时')), heartbeatMs)
  }

  void (async () => {
    const agent = await createProxyAgent(accountId)
    if (closed || sockets.get(accountId) !== attempt) return
    if (!opts.isCurrent()) {
      attempt.close(new Error('Cue 账号或连接已更改'))
      return
    }
    const ws = new WebSocket(wsUrl, {
      headers: {
        Origin: CUE_ORIGIN,
        Authorization: `Bearer ${token}`,
        Cookie: `cue_session_id=${token}; session_id=${token}`,
        'x-product-name': 'manus-agents',
        'x-client-type': 'desktop',
        'x-client-version': '1.0.6',
        'x-client-id': deviceId
      },
      ...(agent ? { agent } : {})
    })
    const managed: ConnectedCueSocket = {
      ws, close: attempt.close, joinedSessions: new Set(), listeners: new Set(), closeListeners: new Set(),
      completedMessages: new Set()
    }
    connected = managed
    ws.on('error', (error) => attempt.close(error))
    ws.on('close', () => attempt.close(new Error('Cue 实时连接已关闭')))
    ws.on('message', (data) => {
      if (closed) return
      const packet = parseSocketIoPacket(data.toString())
      try {
        if (packet.kind === 'ping') {
          armHeartbeat()
          ws.send('3')
          return
        }
        if (packet.kind === 'open') {
          const params = asRecord(packet.payload)
          const interval = params?.['pingInterval']
          const timeout = params?.['pingTimeout']
          if (typeof interval === 'number' && typeof timeout === 'number' && interval > 0 && timeout > 0) {
            heartbeatMs = Math.min(2_147_483_647, interval + timeout)
          }
          armHeartbeat()
          ws.send(`40${JSON.stringify({ token })}`)
          return
        }
        if (packet.kind === 'connect') {
          clearTimeout(connectTimer)
          resolveReady(managed)
          return
        }
        if (packet.kind === 'connect_error' || packet.kind === 'disconnect') {
          const detail = packet.kind === 'connect_error' ? asRecord(packet.payload) : null
          attempt.close(new Error(nonEmptyString(detail?.['message']) || 'Cue 实时连接已断开'))
          return
        }
        for (const listener of managed.listeners) listener(packet)
      } catch (error) {
        attempt.close(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })().catch((error: unknown) => attempt.close(error instanceof Error ? error : new Error(String(error))))
  return ready
}

function readAssistantEventText(ev: Record<string, unknown>): string {
  if (typeof ev['content'] === 'string' && ev['content']) {
    return ev['content']
  }
  const contents = ev['contents']
  if (Array.isArray(contents)) {
    const parts = contents
      .map((item) => {
        const part = asRecord(item)
        if (!part) return ''
        const val = part['value'] ?? part['text'] ?? part['content']
        return typeof val === 'string' ? val : ''
      })
      .filter(Boolean)
    if (parts.length > 0) return parts.join('\n')
  }
  return ''
}

interface CueNativeSendOptions {
  accountId: string
  sessionId: string
  agentId?: string
  conversationId?: string
  requestId?: string
  text: string
  wsBaseUrl?: string
  timeoutMs?: number
  settleIdleMs?: number
}

export async function sendCueNativeMessage(opts: CueNativeSendOptions): Promise<CueNativeReplyResult> {
  const { accountId, sessionId } = opts
  const key = JSON.stringify([accountId, sessionId])
  const revision = socketRevision(accountId)
  const credentials = getCueCredentialRevision(accountId)
  const isCurrent = () => socketRevision(accountId) === revision && getCueCredentialRevision(accountId) === credentials
  const turn = (sessionSends.get(key) ?? Promise.resolve()).catch(() => undefined)
    .then(() => sendCueTurn(opts, isCurrent))
  sessionSends.set(key, turn)
  try {
    return await turn
  } finally {
    if (sessionSends.get(key) === turn) sessionSends.delete(key)
  }
}

async function sendCueTurn(opts: CueNativeSendOptions, isCurrent: () => boolean): Promise<CueNativeReplyResult> {
  const { accountId, sessionId, agentId, conversationId, requestId, text } = opts
  if (!isCurrent()) throw new Error('Cue 账号或连接已更改')
  const timeoutMs = opts.timeoutMs ?? 120_000
  const settleIdleMs = opts.settleIdleMs ?? 4_000
  const managed = await ensureConnectedSocket(accountId, {
    wsBaseUrl: opts.wsBaseUrl,
    timeoutMs: Math.min(15_000, timeoutMs),
    isCurrent
  })
  if (!isCurrent() || managed.ws.readyState !== WebSocket.OPEN) throw new Error('Cue 实时连接已关闭')

  const msgId = createCueEventId()
  const sentAtMs = Date.now()
  const messages = new Map<string, { text: string; final: boolean }>()
  let latestReplyId: string | undefined
  let seenUserEcho = false
  let seenRunning = false
  let settled = false
  let turnTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  return await new Promise<CueNativeReplyResult>((resolve, reject) => {
    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
    }

    const cleanup = () => {
      if (turnTimer) clearTimeout(turnTimer)
      clearIdle()
      managed.listeners.delete(onPacket)
      managed.closeListeners.delete(onSocketClosed)
      for (const id of messages.keys()) managed.completedMessages.add(id)
      while (managed.completedMessages.size > 1_000) {
        managed.completedMessages.delete(managed.completedMessages.values().next().value!)
      }
    }

    const activity = (busy: boolean, activityCode: string, activityText?: string) =>
      emitCueWatchEvent({ type: 'activity', accountId, sessionId, agentId, requestId, busy, activityCode, activityText })

    const settleOk = () => {
      if (settled) return
      settled = true
      cleanup()
      activity(false, 'idle')
      const replies = Array.from(messages, ([id, entry]) => ({ id, text: entry.text }))
      const reply = replies.at(-1)
      resolve({
        sessionId,
        messageId: reply?.id ?? msgId,
        ...(reply?.text ? { reply } : {}),
        ...(replies.length > 1 || (reply && !reply.text) ? { replies } : {})
      })
    }

    const settleErr = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      activity(false, 'idle')
      reject(err)
    }

    const armIdleSettle = () => {
      clearIdle()
      if (seenRunning || messages.size === 0) return
      idleTimer = setTimeout(() => {
        settleOk()
        if (!managed.listeners.size) managed.close(new Error('Cue 实时回复已结算'))
      }, settleIdleMs)
    }

    const onSocketClosed = (error: Error) => settleErr(error)

    const progress = (id: string, text: string, final: boolean) => {
      latestReplyId = id
      messages.set(id, { text, final })
      emitCueWatchEvent({ type: 'stream', accountId, sessionId, conversationId, requestId, messageId: id, text, done: false })
      armIdleSettle()
    }

    const onPacket = (packet: ParsedSocketIoPacket) => {
      if (settled || packet.kind !== 'event' || packet.eventName !== 'message') return
      const payload = asRecord(packet.payload)
      if (!payload) return
      const ev = asRecord(payload['event'])
      const payloadSessionId = nonEmptyString(payload['sessionId'] ?? payload['session_id'] ?? ev?.['sessionId'] ?? ev?.['session_id'])
      const matchingEcho = ev?.['type'] === 'chat' && ev['sender'] === 'user' && ev['id'] === msgId
      if (matchingEcho && (!payloadSessionId || payloadSessionId === sessionId)) {
        if (!seenUserEcho && requestId) emitCueWatchEvent({ type: 'accepted', accountId, sessionId, requestId })
        seenUserEcho = true
        return
      }
      if (payloadSessionId !== sessionId) return

      const payloadType = nonEmptyString(payload['type'])
      if (payloadType === 'agent_error' || payloadType === 'error') {
        const msg = nonEmptyString(payload['message'] ?? payload['error']) || 'Cue Agent 执行失败'
        settleErr(new Error(msg))
        return
      }
      if (payloadType !== 'event') return

      if (!ev) return
      const evType = nonEmptyString(ev['type'])

      if (evType === 'chatDelta' && nonEmptyString(ev['sender']) === 'assistant') {
        const targetId = nonEmptyString(ev['targetEventId']) || latestReplyId || createCueEventId()
        const previous = messages.get(targetId)
        if (previous?.final || managed.completedMessages.has(targetId)) return
        const deltaObj = asRecord(ev['delta'])
        const chunk =
          typeof deltaObj?.['content'] === 'string'
            ? deltaObj['content']
            : typeof ev['content'] === 'string'
              ? ev['content']
              : ''
        if (!chunk) return
        progress(targetId, (previous?.text ?? '') + chunk, false)
        return
      }

      if (evType === 'chat' && nonEmptyString(ev['sender']) === 'assistant') {
        const evTs = toOptionalEpochMs(ev['timestamp'] ?? ev['createdAt'] ?? ev['created_at'])
        if (evTs !== null && evTs < sentAtMs - 5_000) return
        const id = nonEmptyString(ev['id']) || latestReplyId || createCueEventId()
        if (managed.completedMessages.has(id)) return
        const fullText = readAssistantEventText(ev)
        if (fullText || messages.has(id)) progress(id, fullText, true)
        return
      }

      if (evType === 'liveStatus' || evType === 'toolUsed') {
        clearIdle()
        const activityText =
          nonEmptyString(ev['title']) ||
          nonEmptyString(ev['toolName']) ||
          nonEmptyString(ev['status']) ||
          '正在执行…'
        activity(true, evType, activityText)
        return
      }

      if (evType === 'statusUpdate') {
        const agentStatus = nonEmptyString(ev['agentStatus'] ?? ev['status'])?.toLowerCase()
        if (agentStatus === 'running') {
          seenRunning = true
          clearIdle()
          activity(true, 'running', 'Cue 正在思考并执行…')
          return
        }
        if (
          agentStatus === 'stopped' ||
          agentStatus === 'waiting' ||
          agentStatus === 'idle' ||
          agentStatus === 'completed'
        ) {
          if (!seenRunning && messages.size === 0) {
            return
          }
          seenRunning = false
          settleOk()
          return
        }
        if (agentStatus === 'error' || agentStatus === 'failed') {
          seenRunning = false
          const msg = nonEmptyString(ev['message']) || 'Cue Agent 执行出错'
          settleErr(new Error(msg))
        }
      }
    }

    managed.listeners.add(onPacket)
    managed.closeListeners.add(onSocketClosed)

    turnTimer = setTimeout(() => {
      if (messages.size) settleOk()
      else settleErr(new Error('等待 Cue 回复超时'))
      if (!managed.listeners.size) managed.close(new Error('等待 Cue 回复超时'))
    }, timeoutMs)

    try {
      if (!managed.joinedSessions.has(sessionId)) {
        managed.ws.send(
          encodeSocketIoEvent('message', {
            id: createCueEventId(),
            timestamp: Date.now(),
            type: 'join_session',
            sessionId,
            lastMessageId: 'new_session',
            version: 2
          })
        )
        managed.joinedSessions.add(sessionId)
      }

      managed.ws.send(
        encodeSocketIoEvent('message', {
          id: msgId,
          timestamp: Date.now(),
          type: 'user_message',
          sessionId,
          messageType: 'text',
          taskMode: 'standard',
          content: text,
          attachments: [],
          deliveryMode: 'interrupt'
        })
      )
    } catch (err) {
      settleErr(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
