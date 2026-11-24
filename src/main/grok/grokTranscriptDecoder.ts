/**
 * Decodes Grok Bot 0.79.3 transcript entries (`GrokBotTranscriptEntry`) and
 * `GrokBotMessagingCard` payloads into normalized BotHub rich message / approval
 * / widget / media / tool-call structures.
 */

import type {
  MuseMediaPartView,
  MuseOptionWidgetView,
  MuseRichWidgetView,
  MuseToolCallView
} from '@shared/ipc'
import { guessMediaMimeFromName } from '../mediaMime'

export interface GrokPendingApprovalItem {
  /** Composite id: `<kind>:<agentId>:<requestId>:<entryId>` or `card:<cardId>:<version>` */
  id: string
  kind: 'auto-review' | 'local-tool' | 'connector-grant' | 'virtual-card' | 'messaging-card'
  agentId: string
  sessionId?: string
  entryId: string
  requestId: string
  cardVersion?: number
  title: string
  detail?: string
  reason?: string
  host?: string
  decisionOptions: Array<'allow_once' | 'allow_always' | 'deny' | 'deny_always'>
  raw: Record<string, unknown>
}

export interface ParsedGrokTranscriptEntry {
  entryId: string
  seq: string
  updatedSeq: string
  revision?: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  kind: string
  text: string
  createdAtMs: number
  hasTimestamp: boolean
  isStreaming: boolean
  bodyOmitted?: boolean
  clientNonce?: string
  requestId?: string
  widgets?: MuseOptionWidgetView[]
  richWidgets?: MuseRichWidgetView[]
  media?: MuseMediaPartView[]
  toolCall?: MuseToolCallView
  approval?: GrokPendingApprovalItem
  settledApprovalKey?: string
}

export function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

export function decodeTranscriptBody(raw: Record<string, unknown>): Record<string, unknown> {
  const body = raw['body']
  if (typeof body === 'string' && body.length > 0) {
    try {
      const bytes = Uint8Array.from(atob(body.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
      const parsed = asObj(JSON.parse(new TextDecoder().decode(bytes)))
      if (parsed) return { ...parsed, ...raw }
    } catch {
      return raw
    }
  }
  return raw
}

export function extractGrokWidgets(
  e: Record<string, unknown>,
  entryIdFallback?: string
): MuseOptionWidgetView[] | undefined {
  const entryId = str(e['id'] ?? e['entry_id'] ?? e['entryId'] ?? entryIdFallback)
  const msg = asObj(e['message'])
  const widget = asObj(msg?.['widget'] ?? e['widget'])
  if (!widget || !Array.isArray(widget['options'])) return undefined

  const labels: string[] = []
  const values: string[] = []
  for (const rawOpt of widget['options'] as unknown[]) {
    if (typeof rawOpt === 'string') {
      const trimmed = rawOpt.trim()
      if (trimmed) {
        labels.push(trimmed)
        values.push(trimmed)
      }
      continue
    }
    const o = asObj(rawOpt)
    if (!o) continue
    const label = str(o['label'] ?? o['text'] ?? o['title'] ?? o['value'] ?? o['id']).trim()
    const val = str(o['value'] ?? o['id'] ?? label).trim()
    if (!label) continue
    labels.push(label)
    values.push(val || label)
  }
  if (labels.length === 0) return undefined

  const resp = asObj(widget['response'])
  const selectedRaw = str(resp?.['value'] ?? resp?.['optionId'] ?? resp?.['answer']).trim()
  let selectedText: string | undefined
  if (selectedRaw) {
    const idx = values.indexOf(selectedRaw)
    selectedText = idx >= 0 ? labels[idx] : selectedRaw
  }

  return [
    {
      kind: 'option',
      widgetId: str(widget['id'] ?? entryId ?? 'grok_w'),
      entryId: entryId || undefined,
      widgetSource: 'grok-widget',
      options: labels,
      optionValues: values,
      buttonStyle: 'center_aligned_filled',
      customInputPlaceholder: str(widget['placeholder']) || undefined,
      baseVersion: 1,
      selectedText
    }
  ]
}

export function extractGrokRichWidgets(
  e: Record<string, unknown>,
  entryIdFallback?: string
): MuseRichWidgetView[] | undefined {
  const entryId = str(e['id'] ?? e['entry_id'] ?? entryIdFallback ?? 'grok_rw')
  const msg = asObj(e['message'])
  const msgType = str(msg?.['type'] ?? e['type'])
  const out: MuseRichWidgetView[] = []

  // Visualization / HTML / Markdown canvas artifacts
  if (msgType === 'visualization' || msg?.['visualization']) {
    const vis = asObj(msg?.['visualization'] ?? msg) || {}
    const html = str(vis['html'] ?? vis['srcDoc'])
    const md = str(vis['markdown'] ?? vis['content'])
    const title = str(vis['title'] ?? 'Visualization')
    if (html) {
      out.push({ kind: 'html', widgetId: `${entryId}_vis`, html, downloadable: true })
    } else if (md) {
      out.push({ kind: 'markdown', widgetId: `${entryId}_md`, title, markdown: md })
    }
  }

  // User Form (`type: "user-form"`) — interactive form card wired to SubmitGrokBotUserForm
  if (msgType === 'user-form' || msg?.['form']) {
    const form = asObj(msg?.['form'] ?? msg) || {}
    const title = str(form['title'] ?? msg?.['title'] ?? 'Form Request')
    const subtitle = str(form['subtitle'] ?? form['description'] ?? msg?.['subtitle']) || undefined
    const rawFields = Array.isArray(form['fields']) ? (form['fields'] as unknown[]) : []
    const fields = rawFields
      .map((f, idx) => {
        const fo = asObj(f) || {}
        const fid = str(fo['id'] ?? fo['name'] ?? `field_${idx}`)
        const flabel = str(fo['label'] ?? fid)
        const ftype = str(fo['type']) || undefined
        const frequired = Boolean(fo['required'])
        const fplaceholder = str(fo['placeholder'] ?? fo['description']) || undefined
        const fsecret = Boolean(fo['secret'] || ftype === 'password' || ftype === 'secret')
        const rawOpts = Array.isArray(fo['options']) ? (fo['options'] as unknown[]) : []
        const options = rawOpts
          .map((o) => {
            if (typeof o === 'string') return { id: o, label: o }
            const oo = asObj(o)
            if (!oo) return null
            const oid = str(oo['id'] ?? oo['value'] ?? oo['label'])
            const olabel = str(oo['label'] ?? oid)
            return oid ? { id: oid, label: olabel } : null
          })
          .filter((x): x is { id: string; label: string } => Boolean(x))
        return {
          id: fid,
          label: flabel,
          type: ftype,
          required: frequired,
          placeholder: fplaceholder,
          secret: fsecret,
          options: options.length > 0 ? options : undefined
        }
      })
      .filter((x) => x.label)
    if (fields.length > 0) {
      out.push({
        kind: 'grok_form',
        widgetId: `${entryId}_form`,
        formKind: 'user-form',
        entryId,
        title,
        subtitle,
        fields
      })
    }
  }

  // Secret Request (`type: "secret-request"`) — interactive secret input wired to SubmitGrokBotSecret
  if (msgType === 'secret-request' || msg?.['secretRequest'] || msg?.['secret_request']) {
    const sec = asObj(msg?.['secretRequest'] ?? msg?.['secret_request'] ?? msg) || {}
    const secretName = str(sec['name'] ?? sec['secretName'] ?? sec['secret_name'] ?? sec['key'] ?? 'SECRET')
    const title = str(sec['title'] ?? `Secret Requested: ${secretName}`)
    const subtitle = str(sec['description'] ?? sec['reason'] ?? sec['subtitle']) || undefined
    out.push({
      kind: 'grok_form',
      widgetId: `${entryId}_secret`,
      formKind: 'secret-request',
      entryId,
      title,
      subtitle,
      fields: [
        {
          id: secretName,
          label: secretName,
          type: 'password',
          required: true,
          secret: true,
          placeholder: str(sec['placeholder']) || `Enter ${secretName}…`
        }
      ]
    })
  }

  // Email / Slack / Meeting drafts
  const draft = asObj(msg?.['draft'])
  if (draft) {
    const subject = str(draft['subject'] ?? draft['meetingTitle'] ?? msgType)
    const to = str(draft['to'] ?? draft['target'] ?? draft['recipientName'])
    const body = str(draft['body'])
    const md = [
      subject ? `**${subject}**` : '',
      to ? `*To:* \`${to}\`` : '',
      body
    ]
      .filter(Boolean)
      .join('\n\n')
    if (md) {
      out.push({
        kind: 'markdown',
        widgetId: `${entryId}_draft`,
        title: subject || 'Draft',
        markdown: md
      })
    }
  }

  return out.length > 0 ? out : undefined
}

export function extractGrokMedia(e: Record<string, unknown>): MuseMediaPartView[] | undefined {
  const msg = asObj(e['message'])
  const out: MuseMediaPartView[] = []
  const seen = new Set<string>()

  const pushAtt = (att: Record<string, unknown>, fallbackMime?: string) => {
    const path = str(
      att['url'] ??
        att['presignedUrl'] ??
        att['presigned_url'] ??
        att['downloadUrl'] ??
        att['download_url'] ??
        att['imageUrl'] ??
        att['image_url'] ??
        att['videoUrl'] ??
        att['video_url'] ??
        att['mediaUrl'] ??
        att['media_url'] ??
        att['fileUrl'] ??
        att['file_url'] ??
        att['path'] ??
        att['alias'] ??
        att['filePath'] ??
        att['file_path']
    ).trim()
    if (!path || seen.has(path)) return
    seen.add(path)
    const name = str(
      att['name'] ??
        att['fileName'] ??
        att['file_name'] ??
        att['title'] ??
        path.split(/[?#]/, 1)[0]?.split('/').pop() ??
        'attachment'
    )
    const rawMime = str(att['mimeType'] ?? att['mime_type'] ?? att['contentType'] ?? att['content_type']).trim()
    const mime = rawMime || guessMediaMimeFromName(name || path) || fallbackMime || undefined
    const looksImg =
      Boolean(mime?.startsWith('image/')) ||
      /\.(png|jpe?g|gif|webp|svg|avif|bmp)(?:[?#].*)?$/i.test(path || name)
    out.push({
      kind: looksImg ? 'image' : 'file',
      path,
      name,
      mimeType: mime
    })
  }

  const single = asObj(msg?.['attachment'] ?? e['attachment'])
  if (single) {
    pushAtt(single)
  } else if (
    msg &&
    (str(msg['type']).toLowerCase() === 'attachment' ||
      Boolean(
        msg['path'] ??
          msg['url'] ??
          msg['alias'] ??
          msg['presignedUrl'] ??
          msg['videoUrl'] ??
          msg['imageUrl']
      ))
  ) {
    pushAtt(msg)
  } else if (
    str(e['kind'] ?? e['entry_kind'] ?? e['entryKind']).toLowerCase() === 'user-attachment'
  ) {
    pushAtt(e)
  }

  const containerKeys: Array<[string, string | undefined]> = [
    ['attachments', undefined],
    ['images', 'image/png'],
    ['videos', 'video/mp4'],
    ['media', undefined],
    ['files', undefined],
    ['artifacts', undefined]
  ]
  for (const [k, defMime] of containerKeys) {
    for (const parent of [msg, e]) {
      const list = parent?.[k]
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (typeof item === 'string' && item.trim()) {
          pushAtt({ url: item.trim() }, defMime)
        } else {
          const o = asObj(item)
          if (o) pushAtt(o, defMime)
        }
      }
    }
  }

  // User message `attachment_paths` + `attachment_names`
  if (Array.isArray(e['attachmentPaths']) || Array.isArray(e['attachment_paths'])) {
    const paths = ((e['attachmentPaths'] ?? e['attachment_paths']) as unknown[]).map(str)
    const names = Array.isArray(e['attachmentNames'] ?? e['attachment_names'])
      ? ((e['attachmentNames'] ?? e['attachment_names']) as unknown[]).map(str)
      : []
    paths.forEach((p, idx) => {
      if (!p || seen.has(p)) return
      seen.add(p)
      const n = names[idx] || p.split('/').pop() || 'attachment'
      const mime = guessMediaMimeFromName(n || p)
      const looksImg = Boolean(mime?.startsWith('image/')) || /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(n || p)
      out.push({
        kind: looksImg ? 'image' : 'file',
        path: p,
        name: n,
        ...(mime ? { mimeType: mime } : {})
      })
    })
  }

  return out.length > 0 ? out : undefined
}

/**
 * Extract live or settled approval cards from a Grok transcript entry:
 * - `auto-review-approval` (`ResolveGrokBotAutoReviewApproval`)
 * - `local-tool-permission` (`ResolveGrokBotLocalToolPermission`)
 * - `connector-grant` (`ResolveGrokBotConnectorGrant`)
 * - `virtual-card` (`ResolveGrokBotVirtualCardApproval`)
 */
export function extractGrokApproval(
  e: Record<string, unknown>,
  agentId: string,
  sessionId?: string
): { pending?: GrokPendingApprovalItem; settledKey?: string } {
  const entryId = str(e['id'] ?? e['entry_id'] ?? e['entryId'])
  const msg = asObj(e['message'])
  const msgType = str(msg?.['type'] ?? e['type'])

  // 1. Auto-review approval
  if (msgType === 'auto-review-approval' || msg?.['approval']) {
    const appObj = asObj(msg?.['approval'] ?? e['approval']) || {}
    const requestId = str(appObj['requestId'] ?? appObj['request_id'] ?? appObj['id'] ?? entryId)
    const status = str(appObj['status'] ?? appObj['resolution'] ?? '').toLowerCase()
    const key = `auto-review:${agentId}:${requestId}`
    if (status && status !== 'pending' && status !== 'unspecified' && status !== '0') {
      return { settledKey: key }
    }
    const surface = str(appObj['surface'] ?? appObj['platform'])
    const cmd = str(appObj['command'] ?? appObj['summary'] ?? appObj['description'])
    return {
      pending: {
        id: `${key}:${entryId}`,
        kind: 'auto-review',
        agentId,
        sessionId,
        entryId,
        requestId,
        title: str(appObj['title'] ?? 'Auto-review 审批请求'),
        detail: cmd || undefined,
        reason: str(appObj['reason']) || undefined,
        host: surface || undefined,
        decisionOptions: ['allow_once', 'allow_always', 'deny'],
        raw: appObj
      }
    }
  }

  // 2. Local tool permission
  if (msgType === 'local-tool-permission' || msg?.['ask']) {
    const ask = asObj(msg?.['ask'] ?? e['ask']) || {}
    const requestId = str(ask['requestId'] ?? ask['request_id'] ?? ask['id'] ?? entryId)
    const status = str(ask['status'] ?? ask['resolution'] ?? '').toLowerCase()
    const key = `local-tool:${agentId}:${requestId}`
    if (status && status !== 'pending' && status !== 'unspecified' && status !== '0') {
      return { settledKey: key }
    }
    const target = str(ask['target'] ?? ask['toolName'] ?? ask['command'] ?? '本机工具调用')
    return {
      pending: {
        id: `${key}:${entryId}`,
        kind: 'local-tool',
        agentId,
        sessionId,
        entryId,
        requestId,
        title: `允许调用本机工具：${target}`,
        detail: str(ask['description'] ?? ask['summary']) || undefined,
        reason: str(ask['reason']) || undefined,
        decisionOptions: ['allow_once', 'allow_always', 'deny', 'deny_always'],
        raw: ask
      }
    }
  }

  // 3. Connector grant
  if (msgType === 'connector-grant' || msg?.['connectorGrant']) {
    const grant = asObj(msg?.['connectorGrant'] ?? msg) || {}
    const requestId = str(grant['requestId'] ?? grant['request_id'] ?? entryId)
    const status = str(grant['status'] ?? grant['resolution'] ?? '').toLowerCase()
    const key = `connector-grant:${agentId}:${requestId}`
    if (status && status !== 'pending' && status !== 'unspecified' && status !== '0') {
      return { settledKey: key }
    }
    const connector = str(grant['connector'] ?? grant['service'] ?? '外部连接器')
    return {
      pending: {
        id: `${key}:${entryId}`,
        kind: 'connector-grant',
        agentId,
        sessionId,
        entryId,
        requestId,
        title: `授权访问连接器：${connector}`,
        detail: str(grant['scope'] ?? grant['description']) || undefined,
        host: connector,
        decisionOptions: ['allow_once', 'allow_always', 'deny'],
        raw: grant
      }
    }
  }

  // 4. Virtual card spend approval
  if (msgType === 'virtual-card' || msgType === 'virtual-card-approval' || msg?.['virtualCard']) {
    const vc = asObj(msg?.['virtualCard'] ?? msg) || {}
    const requestId = str(vc['requestId'] ?? vc['request_id'] ?? entryId)
    const status = str(vc['status'] ?? vc['outcome'] ?? '').toLowerCase()
    const key = `virtual-card:${agentId}:${requestId}`
    if (status && status !== 'pending' && status !== 'unspecified' && status !== '0') {
      return { settledKey: key }
    }
    const merchant = str(vc['merchantName'] ?? vc['merchant_name'] ?? 'Merchant')
    const amount = vc['amountCents'] ?? vc['amount_cents']
    const currency = str(vc['currency'] ?? 'USD')
    const amountText =
      typeof amount === 'number' ? `${(amount / 100).toFixed(2)} ${currency}` : undefined
    return {
      pending: {
        id: `${key}:${entryId}`,
        kind: 'virtual-card',
        agentId,
        sessionId,
        entryId,
        requestId,
        title: `虚拟卡支付审批：${merchant}`,
        detail: amountText,
        host: merchant,
        decisionOptions: ['allow_once', 'deny'],
        raw: vc
      }
    }
  }

  return {}
}

/** Convert a 0.79.3 `GrokBotMessagingCard` into either a pending approval or option widget. */
export function parseGrokMessagingCard(
  card: Record<string, unknown>,
  agentId: string,
  sessionId?: string
): {
  approval?: GrokPendingApprovalItem
  settledKey?: string
  widget?: MuseOptionWidgetView
  richWidget?: MuseRichWidgetView
} {
  const cardId = str(card['cardId'] ?? card['card_id'])
  if (!cardId) return {}
  const version = Number(card['version'] ?? 1)
  const state = card['state']
  const isPending =
    state === 1 ||
    state === 'GROK_BOT_MESSAGING_CARD_STATE_PENDING' ||
    state === 'GROK_BOT_MESSAGING_CARD_STATE_OPEN' ||
    state === 'PENDING' ||
    state === 'OPEN' ||
    state == null
  const key = `card:${cardId}`
  if (!isPending) {
    return { settledKey: key }
  }

  const kind = card['kind']
  const title = str(card['title'] ?? 'Grok Bot 请求确认')
  const subtitle = str(card['subtitle'])
  const detailObj = asObj(card['detail'])

  // Form / Secret-request MessagingCard -> interactive grok_form richWidget
  const isFormKind =
    kind === 3 ||
    kind === 'GROK_BOT_MESSAGING_CARD_KIND_FORM' ||
    kind === 'FORM' ||
    str(card['subtype']).toLowerCase().includes('secret') ||
    (Array.isArray(card['fields']) && (card['fields'] as unknown[]).length > 0)

  if (isFormKind) {
    const rawFields = Array.isArray(card['fields']) ? (card['fields'] as unknown[]) : []
    const fields = rawFields
      .map((f, idx) => {
        const fo = asObj(f) || {}
        const fid = str(fo['id'] ?? fo['name'] ?? `field_${idx}`)
        const flabel = str(fo['label'] ?? fid)
        const ftype = str(fo['type']) || undefined
        const frequired = Boolean(fo['required'])
        const fplaceholder = str(fo['placeholder']) || undefined
        const fsecret = Boolean(fo['secret'] || ftype === 'password' || ftype === 'secret')
        const rawOpts = Array.isArray(fo['options']) ? (fo['options'] as unknown[]) : []
        const options = rawOpts
          .map((o) => {
            if (typeof o === 'string') return { id: o, label: o }
            const oo = asObj(o)
            if (!oo) return null
            const oid = str(oo['id'] ?? oo['value'] ?? oo['label'])
            const olabel = str(oo['label'] ?? oid)
            return oid ? { id: oid, label: olabel } : null
          })
          .filter((x): x is { id: string; label: string } => Boolean(x))
        return {
          id: fid,
          label: flabel,
          type: ftype,
          required: frequired,
          placeholder: fplaceholder,
          secret: fsecret,
          options: options.length > 0 ? options : undefined
        }
      })
      .filter((x) => x.label)

    const fallbackFields =
      fields.length > 0
        ? fields
        : [
            {
              id: str(card['subtype']) || 'value',
              label: title,
              type: 'password',
              required: true,
              secret: true,
              placeholder: subtitle || 'Enter value…'
            }
          ]

    return {
      richWidget: {
        kind: 'grok_form',
        widgetId: `${cardId}_cardform`,
        formKind: 'messaging-card',
        entryId: cardId,
        cardVersion: version,
        title,
        subtitle: subtitle || undefined,
        fields: fallbackFields
      }
    }
  }

  // Choice card -> interactive option chips
  const options = card['options']
  if (
    kind === 2 ||
    kind === 'GROK_BOT_MESSAGING_CARD_KIND_CHOICE' ||
    (Array.isArray(options) && options.length > 0)
  ) {
    const opts = (Array.isArray(options) ? options : [])
      .map((o) => asObj(o))
      .filter((o): o is Record<string, unknown> => Boolean(o))
    const labels = opts.map((o) => str(o['label'] ?? o['id'])).filter(Boolean)
    const values = opts.map((o) => str(o['id'] ?? o['label'])).filter(Boolean)
    if (labels.length > 0) {
      return {
        widget: {
          kind: 'option',
          widgetId: cardId,
          entryId: cardId,
          cardVersion: version,
          widgetSource: 'grok-card',
          options: labels,
          optionValues: values,
          buttonStyle: 'center_aligned_filled',
          baseVersion: version
        }
      }
    }
    return {}
  }

  // Payment details enrichment (`GrokBotMessagingCardPayment`)
  const paymentObj = asObj(card['payment'])
  let paymentNote = ''
  if (paymentObj) {
    const cents = Number(paymentObj['amount_cents'] ?? paymentObj['amountCents'] ?? 0)
    const currency = str(paymentObj['currency'] ?? 'USD').toUpperCase()
    const merchant = str(paymentObj['merchant_name'] ?? paymentObj['merchantName'])
    if (Number.isFinite(cents) && cents > 0) {
      paymentNote = `${(cents / 100).toFixed(2)} ${currency}${merchant ? ` · ${merchant}` : ''}`
    } else if (merchant) {
      paymentNote = merchant
    }
  }

  // Approval / Payment card -> pending approval banner
  const detailParts = [paymentNote, subtitle || str(detailObj?.['request'])].filter(Boolean)
  return {
    approval: {
      id: `${key}:${version}`,
      kind: 'messaging-card',
      agentId,
      sessionId,
      entryId: cardId,
      requestId: cardId,
      cardVersion: version,
      title,
      detail: detailParts.join(' — ') || undefined,
      reason: str(detailObj?.['reason'] ?? detailObj?.['caution']) || undefined,
      host:
        str(
          paymentObj?.['merchant_name'] ??
            paymentObj?.['merchantName'] ??
            detailObj?.['source_name'] ??
            detailObj?.['source']
        ) || undefined,
      decisionOptions: ['allow_once', 'allow_always', 'deny'],
      raw: card
    }
  }
}

export function textFromEntry(e: Record<string, unknown>): string {
  const msg = asObj(e['message'])
  const widget = asObj(msg?.['widget'] ?? e['widget'])
  const candidates = [
    e['text'],
    e['content'],
    e['message'],
    msg?.['text'],
    msg?.['content'],
    widget?.['prompt'],
    widget?.['title'],
    msg?.['title']
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  if (e['body_omitted'] === true) {
    return '[消息内容较大，正在从云端同步完整附件/正文…]'
  }
  return ''
}

export function parseGrokTranscriptEntry(
  raw: Record<string, unknown>,
  agentId: string,
  sessionId?: string
): ParsedGrokTranscriptEntry | null {
  if (!asObj(raw)) return null
  const e = decodeTranscriptBody(raw)
  const scopedAgent = raw['agentId'] ?? raw['agent_id'] ?? e['agentId'] ?? e['agent_id']
  const scopedSession = raw['sessionId'] ?? raw['session_id'] ?? e['sessionId'] ?? e['session_id']
  if (agentId && (scopedAgent !== undefined && scopedAgent !== agentId ||
    scopedSession !== undefined && scopedSession !== (sessionId ?? ''))) return null
  const seq = str(e['seq'] ?? '0')
  const updatedSeq = str(raw['updated_seq'] ?? raw['updatedSeq'] ?? e['updated_seq'] ?? e['updatedSeq'] ?? seq)
  const kind = str(e['kind'] ?? e['entry_kind'] ?? e['entryKind'] ?? e['type'] ?? '').toLowerCase()
  const entryId = str(
    raw['entry_id'] ?? raw['entryId'] ?? e['id'] ?? e['entry_id'] ?? e['entryId'] ?? e['message_id'] ?? e['messageId'] ?? (seq !== '0' ? `seq_${seq}` : '')
  )
  if (!entryId) return null
  const revision = str(raw['revision'] ?? raw['version'] ?? e['revision']) || undefined
  const timestamp = Number(e['timestampMs'] ?? e['timestamp_ms'] ?? e['sentAtMs'] ?? e['sent_at_ms'] ?? 0)
  const hasTimestamp = Number.isFinite(timestamp) && timestamp > 0
  const createdAtMs = hasTimestamp ? timestamp : Date.now()
  const isStreaming = (raw['is_streaming'] ?? raw['isStreaming'] ?? raw['streaming'] ??
    e['is_streaming'] ?? e['isStreaming'] ?? e['streaming']) === true
  const clientNonce = str(raw['client_nonce'] ?? raw['clientNonce'] ?? e['client_nonce'] ?? e['clientNonce'] ??
    asObj(e['message'])?.['clientNonce'] ?? asObj(e['message'])?.['client_nonce']) || undefined
  const requestId = str(raw['request_id'] ?? raw['requestId'] ?? e['request_id'] ?? e['requestId']) || undefined

  // Tool calls & background events -> tool chips
  if (kind === 'tool-call' || kind === 'event') {
    const evObj = asObj(e['event'] ?? e['toolCall']) || e
    const evType = str(evObj['type'] ?? e['eventType'] ?? e['toolName'] ?? e['name'] ?? 'Tool')
    if (evType === 'automation-changed') return null
    const summary = str(evObj['summary'] ?? evObj['title'] ?? e['summary'] ?? e['text']).trim()
    const statusStr = str(evObj['status'] ?? e['status']).toLowerCase()
    const status: MuseToolCallView['status'] =
      statusStr === 'running' || statusStr === 'in_progress'
        ? 'running'
        : statusStr === 'failed' || statusStr === 'error' || statusStr === 'errored'
          ? 'errored'
          : 'completed'
    return {
      entryId,
      seq,
      updatedSeq,
      revision,
      role: 'tool',
      kind,
      text: '',
      createdAtMs,
      hasTimestamp,
      isStreaming: false,
      requestId,
      toolCall: {
        id: entryId,
        name: evType,
        status,
        summary: summary || undefined
      }
    }
  }

  // Skip internal notices / feedback / voice call telemetry unless user-facing
  if (kind === 'feedback') return null

  const sender = asObj(e['sender'])
  const role = str(raw['role'] ?? asObj(raw['sender'])?.['type'] ?? e['role'] ?? sender?.['role'] ?? sender?.['type'] ?? asObj(e['message'])?.['role']).toLowerCase()
  const fromAgent = e['fromAgent'] ?? e['from_agent']
  let effectiveRole: ParsedGrokTranscriptEntry['role'] = 'system'
  if (/(?:^|_)user$/.test(role) || kind === 'user-attachment') effectiveRole = 'user'
  else if (/(?:^|_)(assistant|bot|agent)$/.test(role) || kind === 'send-message' || Boolean(fromAgent)) effectiveRole = 'assistant'
  else if (kind === 'message') effectiveRole = 'user'

  const text = textFromEntry(e)
  const widgets = extractGrokWidgets(e, entryId)
  const richWidgets = extractGrokRichWidgets(e, entryId)
  const media = extractGrokMedia(e)
  const approvalInfo =
    effectiveRole === 'assistant' ? extractGrokApproval(e, agentId, sessionId) : {}

  // Embedded messaging card inside entry if present
  const embeddedCard = asObj(asObj(e['message'])?.['card'] ?? e['card'])
  let cardApproval = approvalInfo.pending
  let settledKey = approvalInfo.settledKey
  let mergedWidgets = widgets
  let mergedRichWidgets = richWidgets
  if (embeddedCard) {
    const parsedCard = parseGrokMessagingCard(embeddedCard, agentId, sessionId)
    if (parsedCard.approval) cardApproval = parsedCard.approval
    if (parsedCard.settledKey) settledKey = parsedCard.settledKey
    if (parsedCard.widget) {
      mergedWidgets = [...(mergedWidgets ?? []), parsedCard.widget]
    }
    if (parsedCard.richWidget) {
      mergedRichWidgets = [...(mergedRichWidgets ?? []), parsedCard.richWidget]
    }
  }

  return {
    entryId,
    seq,
    updatedSeq,
    revision,
    role: effectiveRole,
    kind,
    text,
    createdAtMs,
    hasTimestamp,
    isStreaming,
    bodyOmitted: Boolean(e['body_omitted'] ?? e['bodyOmitted']),
    clientNonce,
    requestId,
    widgets: mergedWidgets,
    richWidgets: mergedRichWidgets,
    media,
    approval: cardApproval,
    settledApprovalKey: settledKey
  }
}
