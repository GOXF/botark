import { shallow } from 'zustand/shallow'
import type { IncomingMessage } from '@adapters/types'
import type { MuseHistoryMessageView } from '@shared/ipc'
import { asArray, asObj, str, trimStr } from '@shared/parse'
import type { Bot, ChatMediaPart, ChatMessage } from '@/types'
import { SEND_STILL_PENDING_TEXT } from './delivery'
import { comparableText, splitLeadingQuote } from '../lib/quoteText'

export function harkHistory(data: unknown, botId: string, accountId: string): ChatMessage[] {
  const d = data as {
    conversationId?: string
    messages?: Array<{
      id: string
      role: string
      content: string
      thought?: string | null
      narration?: string | null
      createdAt?: string | number | null
      toolCalls?: Array<{ dispatchId: string; name: string; status: string; url?: string }>
      actions?: Array<{ kind: string; connector?: string; label: string }>
      media?: ChatMessage['media']
      richWidgets?: ChatMessage['richWidgets']
      replyToId?: string
      replyQuote?: string
      replyThumb?: string
    }>
  }
  const uiId = (m: { id: string; role: string }) => (/^user$/i.test(m.role) ? `hark_u_${m.id}` : `hark_${m.id}`)
  const byId = new Map((d.messages ?? []).map((m) => [m.id, m]))
  return (d.messages ?? [])
      .filter(
        (m) =>
          (m.content && m.content.trim()) ||
          // GOXF: the model's private "thought" is never shown (Hark's web app hides it too).
          m.toolCalls?.length || m.narration ||
          (m.media && m.media.length > 0) ||
          (m.richWidgets && m.richWidgets.length > 0)
      )
      .map((m, i, shown) => {
        const isUser = /^user$/i.test(m.role)
        const target = m.replyToId ? byId.get(m.replyToId) : undefined
        // Answering the message right above is the obvious case: quoting it is noise.
        const quoted = m.replyQuote && !(target && shown[i - 1]?.id === target.id)
        // GOXF: our own quote replies carry "> quote" in the text; show it once, as the chip.
        const split = isUser ? splitLeadingQuote(m.content?.trim() || '') : { body: m.content?.trim() || '' }
        const ts =
          typeof m.createdAt === 'number'
            ? m.createdAt
            : typeof m.createdAt === 'string'
              ? Date.parse(m.createdAt) || Date.now()
              : Date.now()
        const tools: ChatMessage['tools'] =
          m.toolCalls && m.toolCalls.length > 0
            ? m.toolCalls.map((tc) => ({
                id: tc.dispatchId,
                name: tc.name,
                status:
                  tc.status === 'running'
                    ? 'running'
                    : tc.status === 'failed'
                      ? 'errored'
                      : 'completed',
                summary: tc.url || m.narration || undefined
              }))
            : m.narration
              ? [
                  {
                    id: `hark_thought_${m.id}`,
                    name: 'Agent Activity',
                    status: 'completed',
                    summary: m.narration.slice(0, 140)
                  }
                ]
              : undefined
        return {
          id: uiId(m),
          botId,
          accountId,
          role: isUser ? 'user' : 'bot',
          text: split.body,
          createdAt: ts,
          delivery: isUser ? 'sent' : undefined,
          richWidgets: m.richWidgets,
          tools,
          ...(m.media && m.media.length > 0 ? { media: m.media } : {}),
          ...(quoted
            ? { replyQuote: m.replyQuote, ...(target ? { replyToId: uiId(target) } : {}), ...(m.replyThumb ? { replyThumb: m.replyThumb } : {}) }
            : split.quote
              ? { replyQuote: split.quote }
              : {})
        }
      })
}

export function museHistory(rows: readonly MuseHistoryMessageView[], botId: string, accountId: string): ChatMessage[] {
  return rows.map((row) => ({
    id: row.id,
    botId,
    accountId,
    role: row.role,
    text: row.text,
    createdAt: row.createdAt,
    delivery: row.role === 'user' ? 'sent' : undefined,
    widgets: row.widgets,
    richWidgets: row.richWidgets,
    tools: row.tools,
    media: row.media
  }))
}

type AssistantHistoryRow = Pick<ChatMessage, 'id' | 'text' | 'createdAt' | 'tools' | 'media'> & {
  role: 'user' | 'assistant'
}

function assistantHistory(
  rows: readonly AssistantHistoryRow[],
  botId: string,
  accountId: string,
  includeMedia: boolean
): ChatMessage[] {
  return rows.map((row) => ({
    id: row.id,
    botId,
    accountId,
    role: row.role === 'user' ? 'user' : 'bot',
    text: row.text,
    createdAt: row.createdAt,
    delivery: row.role === 'user' ? 'sent' : undefined,
    ...(row.tools?.length ? { tools: row.tools } : {}),
    ...(includeMedia && row.media?.length ? { media: row.media } : {})
  }))
}

export function hermesHistory(data: unknown, botId: string, accountId: string): ChatMessage[] | undefined {
  if (Array.isArray(data)) return assistantHistory(data as AssistantHistoryRow[], botId, accountId, true)
}

export function dsBotHistory(
  data: unknown,
  botId: string,
  accountId: string,
  agentId?: string
): ChatMessage[] | undefined {
  if (!Array.isArray(data)) return undefined
  const out: ChatMessage[] = []
  for (const item of data) {
    const row = asObj(item)
    if (!row) continue
    const id = typeof row.id === 'string' && row.id ? row.id : ''
    const role = row.role === 'user' ? 'user' : 'bot'
    const senderName = typeof row.senderName === 'string' && row.senderName.trim() ? row.senderName.trim() : ''
    const rawText = typeof row.text === 'string' ? row.text : ''
    const text =
      role === 'bot' && senderName && agentId?.startsWith('room:')
        ? `**${senderName}**：${rawText}`
        : rawText
    if (!id || (!text.trim() && !Array.isArray(row.media) && !Array.isArray(row.tools))) continue
    out.push({
      id,
      botId,
      accountId,
      ...(agentId ? { agentId } : {}),
      role,
      text,
      createdAt: typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : Date.now(),
      delivery: role === 'user' ? 'sent' : undefined,
      ...(Array.isArray(row.tools) && row.tools.length > 0 ? { tools: row.tools as ChatMessage['tools'] } : {}),
      ...(Array.isArray(row.media) && row.media.length > 0 ? { media: row.media as ChatMessage['media'] } : {})
    })
  }
  return out
}

export function antigravityHistory(data: unknown, botId: string, accountId: string): ChatMessage[] | undefined {
  const rows = asObj(data)?.messages
  if (Array.isArray(rows)) return assistantHistory(rows as AssistantHistoryRow[], botId, accountId, false)
}

export function grokHistory(data: unknown, botId: string, accountId: string, agentId: string): ChatMessage[] | undefined {
  // Prefer main's pre-decoded, chronological rows with presigned media URLs.
  const rows = asObj(data)?.hydrated
  if (!Array.isArray(rows)) return
  return (rows as Record<string, unknown>[]).map((row, idx) => ({
    id: str(row.id ?? `grok_h_${idx}`),
    botId,
    accountId,
    agentId,
    role: row.role === 'user' ? 'user' : 'bot',
    text: str(row.text),
    createdAt: Number(row.createdAt ?? Date.now()) || Date.now(),
    delivery: row.role === 'user' ? 'sent' : undefined,
    ...(Array.isArray(row.widgets) ? { widgets: row.widgets as ChatMessage['widgets'] } : {}),
    ...(Array.isArray(row.richWidgets) ? { richWidgets: row.richWidgets as ChatMessage['richWidgets'] } : {}),
    ...(Array.isArray(row.media) ? { media: row.media as ChatMessage['media'] } : {}),
    ...(Array.isArray(row.tools) ? { tools: row.tools as ChatMessage['tools'] } : {})
  }))
}

function normalizeDotMsgId(rawId: string, role: ChatMessage['role']): string {
  const clean = rawId.replace(/^(dot_u_|dot_)+/, '')
  return role === 'user' ? `dot_u_${clean}` : `dot_${clean}`
}

type DotHistoryRow = Pick<ChatMessage, 'id' | 'role' | 'text' | 'media'> & { createdAtMs: number }

export function dotHistory(data: unknown, botId: string, accountId: string): ChatMessage[] {
  return (asArray(data) as DotHistoryRow[])
    .filter((row) => (row.text && row.text.trim()) || (row.media && row.media.length > 0))
    .map((row) => ({
      id: normalizeDotMsgId(row.id, row.role),
      botId,
      accountId,
      role: row.role,
      text: (row.text || '').trim(),
      createdAt: row.createdAtMs || Date.now(),
      delivery: row.role === 'user' ? 'sent' : undefined,
      ...(row.media && row.media.length > 0 ? { media: row.media } : {})
    }))
}

export function cueHistory(data: unknown, botId: string, accountId: string, agentId?: string): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const item of asArray(data)) {
    const row = asObj(item)
    if (!row) continue
    const id = typeof row.id === 'string' ? row.id : ''
    const text = trimStr(row.text)
    const role = row.role
    const createdAt = typeof row.createdAtMs === 'number' ? row.createdAtMs : Date.now()
    const rawTools = Array.isArray(row.tools) ? (row.tools as ChatMessage['tools']) : undefined
    const rawMedia = Array.isArray(row.media) ? (row.media as ChatMessage['media']) : undefined
    const tools = rawTools && rawTools.length > 0 ? rawTools : undefined
    const media = rawMedia && rawMedia.length > 0 ? rawMedia : undefined
    if (!id || (!text && !media) || (role !== 'user' && role !== 'bot')) continue
    messages.push({
      id,
      botId,
      accountId,
      ...(agentId ? { agentId } : {}),
      role,
      text,
      createdAt,
      ...(role === 'user' ? { delivery: 'sent' as const } : {}),
      ...(tools ? { tools } : {}),
      ...(media ? { media } : {})
    })
  }
  return messages
}

/** Merge by path, keeping the previous array when incoming media adds no information. */
function prevMediaMerge(
  prev: ChatMediaPart[] | undefined,
  incoming: ChatMediaPart[] | undefined
): ChatMediaPart[] | undefined {
  if (!incoming?.length) return prev
  if (!prev?.length) return incoming
  const out = [...prev]
  const byPath = new Map<string, number>()
  for (let i = 0; i < out.length; i += 1) {
    byPath.set(out[i]!.path, i)
  }
  let changed = false
  for (const part of incoming) {
    const idx = byPath.get(part.path)
    if (idx === undefined) {
      byPath.set(part.path, out.length)
      out.push(part)
      changed = true
    } else {
      const cur = out[idx]!
      const nextKind = cur.kind === 'image' || part.kind === 'image' ? 'image' : cur.kind
      const nextName = cur.name || part.name
      const nextMime = cur.mimeType || part.mimeType
      const nextImgId = cur.imageId || part.imageId
      if (
        nextKind !== cur.kind ||
        nextName !== cur.name ||
        nextMime !== cur.mimeType ||
        nextImgId !== cur.imageId
      ) {
        out[idx] = {
          ...cur,
          kind: nextKind,
          name: nextName,
          mimeType: nextMime,
          imageId: nextImgId
        }
        changed = true
      }
    }
  }
  return changed ? out : prev
}

function isOmittedPlaceholderText(text: string): boolean {
  return text.startsWith('[消息内容较大') || text.startsWith('[Message body omitted')
}

export function mergeIncomingReply(
  prev: ChatMessage | undefined,
  incoming: IncomingMessage,
  bot: Pick<Bot, 'id' | 'selectedAgentId'>,
  authoritative: boolean
): ChatMessage {
  const text = authoritative
    ? incoming.text
    : incoming.text && (!prev?.text || !isOmittedPlaceholderText(incoming.text))
      ? incoming.text
      : prev?.text ?? ''
  const message: ChatMessage = {
    id: incoming.id,
    botId: bot.id,
    accountId: incoming.accountId,
    ...(bot.selectedAgentId ? { agentId: bot.selectedAgentId } : {}),
    role: 'bot',
    text,
    createdAt: prev?.createdAt ?? incoming.createdAt,
    widgets: incoming.widgets?.length ? incoming.widgets : prev?.widgets,
    tools: incoming.tools?.length ? incoming.tools : prev?.tools,
    media: prevMediaMerge(prev?.media, incoming.media),
    richWidgets: incoming.richWidgets?.length ? incoming.richWidgets : prev?.richWidgets
  }
  return message
}

export function sameChatMessage(previous: ChatMessage, message: ChatMessage): boolean {
  return shallow(previous, message)
}

type ReplyDelta = Pick<ChatMessage, 'text' | 'widgets' | 'tools' | 'media' | 'richWidgets'>

export function mergeReplyDelta(prev: ChatMessage, delta: ReplyDelta, finalized: boolean): ChatMessage {
  // Reconnect can send shorter snapshots. An omitted-body placeholder may be replaced by real text.
  const text = delta.text && ((delta.text.length > prev.text.length && !finalized) ||
    (isOmittedPlaceholderText(prev.text) && !isOmittedPlaceholderText(delta.text))) ? delta.text : prev.text
  const widgets = delta.widgets?.length ? delta.widgets : prev.widgets
  const tools = delta.tools?.length ? delta.tools : prev.tools
  const media = prevMediaMerge(prev.media, delta.media)
  const richWidgets = delta.richWidgets?.length ? delta.richWidgets : prev.richWidgets
  if (
    text === prev.text && widgets === prev.widgets && tools === prev.tools &&
    media === prev.media && richWidgets === prev.richWidgets
  ) {
    return prev
  }
  return { ...prev, text, widgets, tools, media, richWidgets }
}

/** Merge history while preserving turns that arrived or changed after the request began. */
function hasBody(m: ChatMessage): boolean {
  return Boolean(m.text || m.attachments?.length || m.media?.length)
}

export function mergeHydratedMessages(
  existing: ChatMessage[],
  hydrated: ChatMessage[],
  beforeRequest?: ChatMessage[]
): ChatMessage[] {
  if (hydrated.length === 0) return existing
  const { accountId, agentId } = hydrated[0]!
  // Message identity distinguishes updated turns from the request's original snapshot.
  const baseline = beforeRequest && new Set(beforeRequest)
  const liveIds = new Set<string>()
  const normalizedExisting = existing
    .filter((m) => m.accountId === accountId && (!agentId || !m.agentId || m.agentId === agentId))
    .map((m) => {
      const normalized = m.id.startsWith('dot_dot_') ? { ...m, id: m.id.replace(/^dot_dot_/, 'dot_') } : m
      if (baseline && !baseline.has(m)) liveIds.add(normalized.id)
      return normalized
    })
  const hydratedById = new Map(hydrated.map((m) => [m.id, m]))
  const existingById = new Map(normalizedExisting.map((m) => [m.id, m]))
  const fallbackRows = new Map<string, ChatMessage[]>()
  const fallbackKey = (message: ChatMessage) => `${message.role}:${comparableText(message.text)}`
  let earliestHydratedTs = Infinity
  let latestHydratedTs = -Infinity
  for (const message of hydratedById.values()) {
    earliestHydratedTs = Math.min(earliestHydratedTs, message.createdAt)
    latestHydratedTs = Math.max(latestHydratedTs, message.createdAt)
    if (!hasBody(message) || existingById.has(message.id)) continue
    const key = fallbackKey(message)
    const matches = fallbackRows.get(key)
    if (matches) matches.push(message)
    else fallbackRows.set(key, [message])
  }
  const keptLocal: ChatMessage[] = []
  const localByHistoryId = new Map<string, ChatMessage>()
  for (const localMsg of normalizedExisting) {
    if (hydratedById.has(localMsg.id)) continue
    const live = liveIds.has(localMsg.id)
    if (
      hasBody(localMsg) && localMsg.delivery !== 'failed' &&
      (live || (localMsg.role === 'user' && (localMsg.id.startsWith('msg_') || localMsg.id.startsWith('opt_'))))
    ) {
      const candidates = fallbackRows.get(fallbackKey(localMsg))
      const match = candidates?.find((remote) => !localByHistoryId.has(remote.id) &&
        Math.abs(remote.createdAt - localMsg.createdAt) < 120_000)
      if (match) {
        localByHistoryId.set(match.id, localMsg)
        continue
      }
    }
    if (
      live ||
      localMsg.delivery === 'sending' ||
      localMsg.delivery === 'accepted' ||
      localMsg.delivery === 'failed' ||
      localMsg.createdAt < earliestHydratedTs - 1000 ||
      localMsg.createdAt > latestHydratedTs + 1000
    ) {
      keptLocal.push(localMsg)
    }
  }

  const mergedHydrated = Array.from(hydratedById.values(), (remote) => {
    const local = existingById.get(remote.id) ?? localByHistoryId.get(remote.id)
    if (!local) return remote
    const live = liveIds.has(local.id)
    // GOXF: Hark already has this message, so a stale 「正在等待原发送完成」 no longer holds.
    const delivering = local.delivery === 'sending' || local.delivery === 'accepted'
    // The original send may still settle against its local id, so keep the id.
    const keepId = delivering || local.error === SEND_STILL_PENDING_TEXT
    return {
      ...local,
      ...remote,
      id: keepId || live ? local.id : remote.id,
      text: live && local.text && !isOmittedPlaceholderText(local.text) ? local.text : remote.text,
      createdAt: live ? local.createdAt : remote.createdAt,
      widgets: live ? local.widgets ?? remote.widgets : remote.widgets ?? local.widgets,
      richWidgets: live ? local.richWidgets ?? remote.richWidgets : remote.richWidgets ?? local.richWidgets,
      tools: live ? local.tools ?? remote.tools : remote.tools ?? local.tools,
      media: prevMediaMerge(local.media, remote.media),
      // GOXF: the server copy of a message just sent keeps the pictures it was sent with.
      attachments: remote.attachments?.length ? remote.attachments : local.attachments,
      ...(delivering ? { delivery: local.delivery, error: local.error } : { error: undefined })
    }
  })

  const combined = [...keptLocal, ...mergedHydrated]
  combined.sort((a, b) => a.createdAt - b.createdAt)
  const seen = new Set<string>()
  return combined.filter((m) => {
    if (seen.has(m.id)) return false
    seen.add(m.id)
    return true
  })
}
