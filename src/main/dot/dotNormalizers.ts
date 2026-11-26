import type { MuseMediaPartView, MuseToolCallView } from '@shared/ipc'
import { asArray, asObj, str, trimStr } from '@shared/parse'
import { guessMediaMimeFromName, inferMediaMime } from '../mediaMime'
import type { DotStoredAccount } from './dotAuth'

export interface DotProfile {
  id: string
  displayName: string
  avatarType?: string | null
  avatarUrl?: string | null
  color?: string | null
  aeonKind?: string
  isPrimary?: boolean
  scope?: string
  messagingRoomId: string
  activeRootThreadId: string
  status: string
  isPaused?: boolean
  lastCheckInAt?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface DotRoomAttachment {
  attachmentId: string
  type: string
  fileId?: string
  name?: string
  mimeType?: string
  downloadUrl?: string
}

export interface DotRoomMessage {
  id: string
  roomId: string
  role: 'user' | 'bot'
  accountUserId: string
  text: string
  createdAtMs: number
  turnTrigger?: string
  threadTurnId?: string
  attachments?: DotRoomAttachment[]
}

export function normalizeDotProfile(raw: Record<string, unknown>): DotProfile {
  const preview = asObj(raw['messaging_room_preview']) ?? {}
  const rawName = str(
    raw['display_name'] || raw['displayName'] || preview['name'] || 'Dot'
  ).trim()
  return {
    id: str(raw['id']),
    displayName: rawName || 'Dot',
    avatarType: typeof raw['avatar_type'] === 'string' ? raw['avatar_type'] : null,
    avatarUrl: typeof raw['avatar_url'] === 'string' ? raw['avatar_url'] : null,
    color: typeof raw['color'] === 'string' ? raw['color'] : null,
    aeonKind: typeof raw['aeon_kind'] === 'string' ? raw['aeon_kind'] : 'orbit',
    isPrimary: Boolean(raw['is_primary']),
    scope: typeof raw['scope'] === 'string' ? raw['scope'] : 'private',
    messagingRoomId: str(raw['messaging_room_id'] ?? raw['messagingRoomId']),
    activeRootThreadId: str(raw['active_root_thread_id'] ?? raw['activeRootThreadId']),
    status: str(raw['status'] ?? 'active'),
    isPaused: Boolean(raw['is_paused']),
    lastCheckInAt: typeof raw['last_check_in_at'] === 'string' ? raw['last_check_in_at'] : null,
    createdAt: typeof raw['created_at'] === 'string' ? raw['created_at'] : undefined,
    updatedAt: typeof raw['updated_at'] === 'string' ? raw['updated_at'] : undefined
  }
}

export function normalizeDotProfiles(raw: unknown): DotProfile[] {
  return asArray(asObj(raw)?.['items'])
    .map(asObj)
    .filter((item) => item !== null)
    .map(normalizeDotProfile)
    .filter((dot) => dot.id && dot.status !== 'deleting')
}

export function inferDotFileMimeType(name?: string, rawMime?: string): string {
  const guessed = guessMediaMimeFromName(name)
  if (guessed) return guessed
  const lower = (name || '').toLowerCase()
  if (lower.endsWith('.py')) return 'text/x-python'
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.ts') || lower.endsWith('.tsx')) {
    return 'text/javascript'
  }
  if (lower.endsWith('.css')) return 'text/css'
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'text/plain'
  if (rawMime && rawMime !== 'application/octet-stream') return rawMime
  return rawMime || 'application/octet-stream'
}

export function isDotAckMessage(msg: DotRoomMessage): boolean {
  if (
    msg.attachments &&
    msg.attachments.some((a) => a.type === 'file' || a.downloadUrl || a.fileId)
  ) {
    return false
  }
  if (msg.turnTrigger === 'aeon_transplant') {
    return true
  }
  if (msg.text.length < 260) {
    if (
      /做好后|发给你|稍等|正在|马上|开始|我现在就|我会创建|先帮你|我去|为你生成|我先|请稍候|继续处理|I'll|I will|working on|one moment|let me|了解しました|送ります|作成します|少々お待ち|今すぐ|処理します|Je vais|Un instant/i.test(
        msg.text
      )
    ) {
      return true
    }
  }
  return false
}

export function dotAttachmentsToMedia(
  attachments?: DotRoomAttachment[]
): MuseMediaPartView[] | undefined {
  if (!attachments || attachments.length === 0) return undefined
  const out: MuseMediaPartView[] = []
  for (const att of attachments) {
    if (att.type === 'widget' || (!att.downloadUrl && !att.fileId && !att.name)) {
      continue
    }
    const name = att.name || att.fileId || att.attachmentId || 'attachment'
    const mimeType = inferDotFileMimeType(name, att.mimeType)
    const isImg =
      mimeType.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(name)
    const path =
      att.downloadUrl ||
      (att.fileId ? `dotfile://${att.fileId}` : '')
    if (!path) continue
    out.push({
      kind: isImg ? 'image' : 'file',
      path,
      name,
      mimeType
    })
  }
  return out.length > 0 ? out : undefined
}

export function normalizeRoomMessage(raw: Record<string, unknown>, fallbackRoomId = ''): DotRoomMessage {
  const id = str(raw['id'] ?? raw['message_id'])
  const roomId = str(raw['room_id'] ?? fallbackRoomId)
  const accountUserId = str(raw['account_user_id'])
  const isBot =
    accountUserId.startsWith('calpico-member-') ||
    str(raw['role']).toLowerCase() === 'assistant'
  const contentObj = asObj(raw['content']) ?? {}
  const text = str(contentObj['text'] ?? raw['text']).trim()
  const rawAtts: unknown[] = [
    ...asArray(contentObj['attachments']),
    ...asArray(contentObj['images']),
    ...asArray(contentObj['videos']),
    ...asArray(contentObj['media']),
    ...asArray(contentObj['files'])
  ]
  const seenAtt = new Set<string>()
  const attachments: DotRoomAttachment[] = []
  for (const a of rawAtts) {
    const ao = asObj(a)
    if (!ao) continue
    const fileObj = asObj(ao['file']) ?? {}
    const name =
      (typeof fileObj['name'] === 'string' && fileObj['name']) ||
      (typeof ao['name'] === 'string' && ao['name']) ||
      (typeof ao['file_name'] === 'string' && ao['file_name']) ||
      undefined
    const rawMime =
      (typeof fileObj['mime_type'] === 'string' && fileObj['mime_type']) ||
      (typeof ao['mime_type'] === 'string' && ao['mime_type']) ||
      (typeof ao['content_type'] === 'string' && ao['content_type']) ||
      undefined
    const fileId =
      (typeof ao['file_id'] === 'string' && ao['file_id']) ||
      (typeof fileObj['id'] === 'string' && fileObj['id']) ||
      undefined
    const downloadUrl =
      (typeof fileObj['download_url'] === 'string' && fileObj['download_url']) ||
      (typeof fileObj['url'] === 'string' && fileObj['url']) ||
      (typeof ao['download_url'] === 'string' && ao['download_url']) ||
      (typeof ao['url'] === 'string' && ao['url']) ||
      undefined
    const attachmentId = str(ao['attachment_id'] ?? fileObj['id'] ?? fileId)
    const dedupKey = downloadUrl || fileId || attachmentId || name || ''
    if (!dedupKey || seenAtt.has(dedupKey)) continue
    seenAtt.add(dedupKey)
    attachments.push({
      attachmentId,
      type: str(ao['type'] ?? 'file'),
      fileId,
      name,
      mimeType: inferDotFileMimeType(name, rawMime),
      downloadUrl
    })
  }

  // A present metadata object supplies the fields even when they are empty.
  const metadata = asObj(
    raw['message_metadata'] && typeof raw['message_metadata'] === 'object'
      ? raw['message_metadata']
      : raw['metadata']
  ) ?? {}
  const createdStr = typeof raw['created_at'] === 'string' ? raw['created_at'] : ''
  const createdAtMs = createdStr ? Date.parse(createdStr) || Date.now() : Date.now()

  return {
    id,
    roomId,
    role: isBot ? 'bot' : 'user',
    accountUserId,
    text,
    createdAtMs,
    turnTrigger: typeof metadata['turn_trigger'] === 'string' ? metadata['turn_trigger'] : undefined,
    threadTurnId: typeof metadata['thread_turn_id'] === 'string' ? metadata['thread_turn_id'] : undefined,
    ...(attachments.length > 0 ? { attachments } : {})
  }
}

export function messageSignature(msg: DotRoomMessage): string {
  return JSON.stringify([msg.text, msg.attachments ?? []])
}

export function normalizeRoomHistory(
  raw: unknown,
  roomId: string
): { messages: DotRoomMessage[]; hasMore: boolean } {
  const body = asObj(raw)
  const list = Array.isArray(body?.['items']) ? body['items'] : asArray(body?.['data'])
  const messages: DotRoomMessage[] = []
  for (const item of list) {
    const entry = asObj(item)
    if (!entry) continue
    try {
      const id = entry['id'] ?? entry['message_id']
      if (typeof id !== 'string' && typeof id !== 'number') continue
      const message = normalizeRoomMessage(entry, roomId)
      if (message.id && message.roomId === roomId) messages.push(message)
    } catch {
      /* A malformed record does not invalidate the rest of the page. */
    }
  }
  return { messages, hasMore: Boolean(body?.['has_more']) }
}

export function parseDotJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function parseDotJsonObject(text: string): Record<string, unknown> | null {
  return asObj(parseDotJson(text))
}

export function dotApiErrorDetail(body: unknown, status: number): string {
  const obj = asObj(body)
  if (obj && 'detail' in obj) return JSON.stringify(obj['detail'])
  return typeof body === 'string' ? body.slice(0, 200) : `HTTP ${status}`
}

export function parseDotSseLine(line: string): Record<string, unknown> | null {
  if (!line.startsWith('data:')) return null
  const data = line.slice(5).trim()
  if (!data || data === '[DONE]') return null
  return parseDotJsonObject(data)
}

export function parseCelsiusMessage(text: string): Record<string, unknown> | null {
  const frame = parseDotJsonObject(text)
  return frame?.['type'] === 'message' ? asObj(frame['payload']) : null
}

type CalpicoRoomEvent =
  | { type: 'message'; message: DotRoomMessage }
  | { type: 'activity'; code: string; text: string | undefined; busy: boolean }

export function normalizeCalpicoRoomEvent(
  ev: Record<string, unknown>,
  roomId: string
): CalpicoRoomEvent | undefined {
  const evType = str(ev['type'])
  const payload = asObj(ev['payload'] ?? ev) ?? {}
  const evRoomId = str(payload['room_id'] ?? ev['room_id'] ?? roomId)
  if (evRoomId !== roomId) return

  if (evType === 'calpico-message-add' || evType === 'calpico-message-update') {
    const raw = asObj(payload['message'])
    if (!raw) return
    const message = normalizeRoomMessage(raw, evRoomId)
    if (
      !message.id ||
      message.roomId !== roomId ||
      message.role !== 'bot' ||
      (!message.text && !message.attachments?.length)
    ) return
    return { type: 'message', message }
  }
  if (evType === 'calpico-is-responding-heartbeat') {
    const busy = Boolean(payload['typing'])
    return {
      type: 'activity',
      code: busy ? 'thinking' : 'idle',
      text: busy ? 'Dot is responding…' : undefined,
      busy
    }
  }
  if (evType === 'calpico-room-live' || evType === 'calpico-room-live-state') {
    const first = asObj(asArray(payload['threads'])[0])
    const activity = asObj(first?.['activity_status'])
    const statusType = str(activity?.['status_type']).toLowerCase()
    const busy = first?.['turn_status'] === 'in_progress' || (statusType !== '' && statusType !== 'ready')
    return {
      type: 'activity',
      code: busy ? statusType || 'thinking' : 'idle',
      text: busy ? str(activity?.['status_label'] || first?.['summary'] || 'Thinking…') : undefined,
      busy
    }
  }
}

export function normalizeDotNativeTool(
  item: Record<string, unknown>,
  id: string,
  itemType: string
): MuseToolCallView {
  return {
    id,
    name: str(item['tool'] ?? item['command'] ?? itemType),
    status: 'running',
    summary: typeof item['command'] === 'string' ? item['command'] : undefined
  }
}

export function normalizeDotThreadBusy(raw: unknown): boolean | null {
  const thread = asObj(asObj(raw)?.['thread'])
  const type = asObj(thread?.['status'])?.['type']
  if (typeof type !== 'string' || !type) return null
  const statusType = type.toLowerCase()
  return statusType !== 'idle' && statusType !== 'ready' && statusType !== 'completed'
}

export function findDotRoomAttachment(
  messages: DotRoomMessage[],
  fileId: string,
  fileName: string
): DotRoomAttachment | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const attachment of messages[i]!.attachments ?? []) {
      if (!attachment.downloadUrl) continue
      if (
        (fileId && (attachment.fileId === fileId || attachment.attachmentId === fileId)) ||
        (fileName && attachment.name === fileName)
      ) return attachment
    }
  }
}

export function findDotLibraryFile(
  raw: unknown,
  fileId: string
): { name?: string; downloadUrl?: string; fileId?: string } | undefined {
  const body = asObj(raw)
  const nodes = Array.isArray(body?.['items']) ? body['items'] : asArray(body?.['nodes'])
  const node = nodes.map(asObj).find((entry) => entry?.['id'] === fileId || entry?.['node_id'] === fileId)
  if (!node) return
  const title = typeof node['title'] === 'string' ? node['title'] : undefined
  const name = title || (typeof node['name'] === 'string' ? node['name'] : undefined)
  const downloadUrl = typeof node['download_url'] === 'string' ? node['download_url'] : undefined
  return {
    name,
    downloadUrl,
    fileId: !downloadUrl && typeof node['file_id'] === 'string' ? node['file_id'] : undefined
  }
}

export function normalizeDotDownloadedFile(buf: Buffer, fileName: string, contentType?: string) {
  const finalName = fileName || 'document'
  const mimeType = inferMediaMime({
    headerMime: contentType,
    nameOrPath: finalName,
    bytes: buf,
    fallback: inferDotFileMimeType(finalName)
  })
  const isTextLike =
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'image/svg+xml' ||
    /\.(html?|md|markdown|txt|json|csv|py|js|ts|tsx|css|svg|xml|yaml|yml)$/i.test(finalName)

  return {
    name: finalName,
    filename: finalName,
    mimeType,
    size: buf.byteLength,
    dataBase64: buf.toString('base64'),
    ...(isTextLike ? { text: buf.toString('utf8') } : {})
  }
}

export interface DotMemorySnapshotResult {
  markdown: string
  goal?: string
  globalMemoriesCount: number
  roomMessagesCount: number
  sourceHandle?: string
  sourceDotId?: string
  exportedAt: string
}

export function formatDotMemorySnapshot(
  account: Pick<DotStoredAccount, 'email' | 'displayName' | 'planType' | 'activeDotId'>,
  accountId: string,
  rawMemories: unknown,
  rawGoal: unknown,
  messages: DotRoomMessage[],
  exportedAt: string
): DotMemorySnapshotResult {
  const globalMemories: string[] = []
  for (const memory of asArray(asObj(rawMemories)?.['memories'])) {
    const content = trimStr(asObj(memory)?.['content'])
    if (content) globalMemories.push(content)
  }
  const goalStr = trimStr(asObj(rawGoal)?.['goal'])

  // Find the latest `# Dot 记忆快照` compiled by Dot in the room (messages are newest-first or chronological; sort by createdAtMs)
  const sortedMsgs = [...messages].sort((a, b) => a.createdAtMs - b.createdAtMs)
  const snapshotMsgs = sortedMsgs.filter(
    (m) =>
      m.role === 'bot' &&
      (m.text.includes('# Dot 记忆快照') ||
        (m.text.includes('## 1. 身份') && m.text.includes('## 2. 项目')))
  )
  const latestDotSnapshot =
    snapshotMsgs.length > 0 ? snapshotMsgs[snapshotMsgs.length - 1]!.text.trim() : ''

  const sourceHandle = account.email || account.displayName
  const sourceDotId = account.activeDotId
  const source = `\`${sourceHandle || accountId}\` (${account.planType || 'dot'}) · Dot \`${sourceDotId || 'default'}\` · ${exportedAt}`
  const lines: string[] = []

  if (latestDotSnapshot) {
    lines.push(latestDotSnapshot, '', '---', `> 元信息：导出自账号 ${source}`)
  } else {
    lines.push('# Dot 记忆快照', `> 导出自账号 ${source}`)
  }

  if (goalStr) {
    lines.push('')
    lines.push('## 长期目标 (Thread Goal)')
    lines.push(`- ${goalStr}`)
  }

  if (globalMemories.length > 0) {
    lines.push('')
    lines.push('## ChatGPT 全局记忆库 (/backend-api/memories)')
    for (const memory of globalMemories) {
      lines.push(`- ${memory}`)
    }
  }

  if (!latestDotSnapshot && sortedMsgs.length > 0) {
    lines.push('')
    lines.push('## 近期关键对话记录 (Calpico Room)')
    const recent = sortedMsgs.slice(-14)
    for (const m of recent) {
      const speaker = m.role === 'user' ? '用户' : 'Dot'
      const clean = m.text.replace(/\n{3,}/g, '\n\n').trim()
      lines.push(`- **${speaker}**：${clean}`)
    }
  }

  return {
    markdown: lines.join('\n').trim(),
    goal: goalStr || undefined,
    globalMemoriesCount: globalMemories.length,
    roomMessagesCount: sortedMsgs.length,
    sourceHandle,
    sourceDotId,
    exportedAt
  }
}

export function dotSnapshotGoal(markdown: string, goal?: string): string | undefined {
  const explicit = goal?.trim()
  if (explicit) return explicit
  const match = markdown.match(/##\s*长期目标[^\n]*\n+-\s*([^\n]+)/)
  return match?.[1] ? match[1].trim() : explicit
}
