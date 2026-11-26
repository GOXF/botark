import { asObj, str, trimStr } from '@shared/parse'

/** Muse wire text and identifiers must be strings before decoding. */
function museString(value: unknown): string {
  return str(typeof value === 'string' ? value : undefined)
}

export function museEventSessionId(payload: Record<string, unknown>): string {
  return firstField([payload, asObj(payload['chat_context']), asObj(payload['message'])], 'session_id', 'sessionId', 'thread_id', 'threadId') || ''
}

export function chatEventDeviceId(payload: Record<string, unknown>): string {
  return museString(asObj(payload['chat_context'])?.['device_id'])
}

export function chatUserMessageId(payload: Record<string, unknown>): string {
  return museString(payload['message_id']) || museString(payload['user_message_id'])
}

export function chatParentMessageId(payload: Record<string, unknown>): string {
  return museString(payload['user_message_id']) || museString(payload['reply_to_message_id']) ||
    museString(payload['parent_message_id'])
}

export function chatPlaceholderText(payload: Record<string, unknown>): string {
  return museString(payload['text'] || payload['display_text'] || payload['placeholder'])
}

export function chatAckSessionId(ack: Record<string, unknown>): string {
  return museString(ack['session_id']) || museString(asObj(ack['result'])?.['session_id'])
}

export function chatAckIds(ack: Record<string, unknown>): { sessionId: string; userMessageId: string } {
  const result = asObj(ack['result'])
  const userMessageId = museString(ack['message_id']) || museString(result?.['message_id']) ||
    museString(ack['user_message_id']) || museString(result?.['user_message_id'])
  return { sessionId: chatAckSessionId(ack), userMessageId }
}

export function isMuseToolEvent(name: string): boolean {
  return TOOL_EVENT.test(name)
}

export function chatEvent(raw: Record<string, unknown>): MuseChatEvent | undefined {
  if (raw['type'] !== 'event') return
  const name = museString(raw['event']) || museString(raw['event_name'])
  if (!name) return
  const { type, event, event_name, seq, ts_ms, payload, ...fields } = raw
  return { name, seq: Number(seq ?? 0), payload: { ...fields, ...asObj(payload) } }
}

/** Busy activity_code set from muse.ai client (tC/tT). */
export const MUSE_BUSY_ACTIVITY = new Set([
  'responding',
  'composing',
  'making_something',
  'working',
  'waiting_for_subagents',
  'compacting'
])

export function isMuseBusyActivity(code: string): boolean {
  return MUSE_BUSY_ACTIVITY.has(code) || code === 'needs_approval'
}

/** Non-busy / settled codes (online/idle or anything outside the busy set). */
export function isMuseIdleActivity(code: string): boolean {
  if (!code) return true
  if (code === 'online' || code === 'idle') return true
  if (code === 'guided_onboarding') return false
  return !isMuseBusyActivity(code)
}

export interface MuseChatEvent {
  name: string
  seq: number
  payload: Record<string, unknown>
}

export interface MuseToolCall {
  id: string
  name: string
  toolType?: string
  status: 'running' | 'completed' | 'errored'
  summary?: string
}

export interface MuseMediaPart {
  kind: 'image' | 'file'
  path: string
  name?: string
  imageId?: string
  mimeType?: string
}

/** Read-only rich widgets (no commerce actions). */
export type MuseRichWidget =
  | {
      kind: 'shopping_results' | 'shopping_results_v2'
      widgetId: string
      products: Array<{
        name: string
        url?: string
        imageUrl?: string
        price?: string
        retailer?: string
      }>
    }
  | {
      kind: 'shopping_cart'
      widgetId: string
      retailerName?: string
      subtotal?: string
      items: Array<{ id: string; name: string; quantity: number; imageUrl?: string; linePrice?: string }>
    }
  | {
      kind: 'local_map'
      widgetId: string
      html?: string
      places: Array<{ id: string; name: string; latitude: number; longitude: number; category?: string }>
    }
  | {
      kind: 'marketplace_map'
      widgetId: string
      listings: Array<{
        id: string
        name: string
        url?: string
        price?: string
        imageUrl?: string
        latitude?: number
        longitude?: number
      }>
    }
  | { kind: 'html'; widgetId: string; html: string; downloadable?: boolean }
  | { kind: 'slides'; widgetId: string; label: string; path?: string; slug: string }
  | {
      kind: 'image_options'
      widgetId: string
      images: Array<{ path: string; imageId?: string }>
      multiSelect?: boolean
      selectedPath?: string | null
      selectedIndices?: number[]
      baseVersion: number
    }
  | {
      kind: 'text_with_button'
      widgetId: string
      text: string
      buttons: Array<{ label: string; actionText?: string; url?: string; command?: string }>
    }
  | {
      kind: 'generic_list'
      widgetId: string
      title?: string
      items: Array<{ id: string; title: string; subtitle?: string; sendText?: string; url?: string }>
    }
  | {
      kind: 'voice_options'
      widgetId: string
      voices: Array<{ id: string; name: string; description?: string; selected?: boolean }>
    }
  | {
      kind: 'markdown'
      widgetId: string
      title?: string
      markdown: string
      path?: string
    }
  | {
      kind: 'hotel_results'
      widgetId: string
      hotels: Array<{ name: string; price?: string; rating?: string; url?: string; imageUrl?: string; location?: string }>
    }
  | {
      kind: 'idea_cards'
      widgetId: string
      cards: Array<{ id: string; title: string; subtitle?: string; prompt?: string }>
    }
  | {
      kind: 'session_card'
      widgetId: string
      cardType: 'browser' | 'computer' | 'vault'
      title: string
      subtitle?: string
      status?: string
      url?: string
      taskId?: string
      previewSha256?: string
      previewSrc?: string
      actionLabel?: string
    }

export interface MuseOptionWidget {
  kind: 'option'
  widgetId: string
  options: string[]
  buttonStyle: 'dotted_lines' | 'center_aligned_filled'
  customInputPlaceholder?: string
  selectedText?: string | null
  baseVersion: number
}

export interface MuseAgentActivity {
  code: string
  text: string | null
  emoji: string | null
  agentId: string | null
  subagents: number
  busy: boolean
  cta: { command?: string; label?: string } | null
}

export function parseAgentStatus(payload: Record<string, unknown>): MuseAgentActivity {
  const code = museString(payload['activity_code'])
  const ctaRaw = asObj(payload['cta']) ?? {}
  const cta =
    code === 'out_of_credits'
      ? {
          command: museString(ctaRaw['command']) || undefined,
          label: museString(ctaRaw['label']) || undefined
        }
      : null
  return {
    code,
    text: museString(payload['activity_text']) || null,
    emoji: museString(payload['activity_emoji']) || null,
    agentId: museString(payload['agent_id']) || null,
    subagents: Number(payload['count'] ?? 0) || 0,
    busy: isMuseBusyActivity(code),
    cta
  }
}

/** Parse option widgets from a message / presentation payload. */
export function parseOptionWidgets(payload: Record<string, unknown>): MuseOptionWidget[] {
  const bags: unknown[] = []
  for (const key of ['widgets', 'presentations', 'presentation']) {
    const v = payload[key]
    if (Array.isArray(v)) bags.push(...v)
    else if (v && typeof v === 'object') bags.push(v)
  }
  const nested = asObj(payload['transcript']) ?? {}
  for (const key of ['widgets', 'presentations']) {
    const v = nested[key]
    if (Array.isArray(v)) bags.push(...v)
  }
  const out: MuseOptionWidget[] = []
  for (const item of bags) {
    const w = asObj(item) ?? {}
    const kind = museString(w['kind']) || museString(w['type'])
    if (kind !== 'option') continue
    const data = asObj(w['data']) ?? {}
    const optsRaw = Array.isArray(data['options'])
      ? (data['options'] as unknown[])
      : Array.isArray(w['options'])
        ? (w['options'] as unknown[])
        : []
    const options: string[] = []
    for (const o of optsRaw) {
      const option = asObj(o)
      const s = trimStr(option ? option['text'] || option['label'] : o)
      if (s && !options.includes(s)) options.push(s)
    }
    if (!options.length) continue
    const style = museString(data['button_style'] || w['button_style'])
    const custom = asObj(data['custom_input'] || w['custom_input'] || data['customInput']) ?? {}
    const state = asObj(w['state']) ?? {}
    const stateData = asObj(state['data']) ?? {}
    out.push({
      kind: 'option',
      widgetId: museString(w['widget_id'] || w['widgetId'] || w['id']),
      options,
      buttonStyle: style === 'center_aligned_filled' ? 'center_aligned_filled' : 'dotted_lines',
      customInputPlaceholder: museString(custom['placeholder']) || undefined,
      selectedText: (museString(stateData['selectedText']) || museString(state['selectedText']) || null) as string | null,
      baseVersion: Number(state['version'] ?? w['version'] ?? 0) || 0
    })
  }
  return out
}

function coord(v: unknown): { latitude: number; longitude: number } | null {
  const o = asObj(v)
  if (!o) return null
  const latitude = o['latitude']
  const longitude = o['longitude']
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  return { latitude, longitude }
}

/** Parse presentation widgets for read-only display. */
function parsePresentationWidgets(payload: Record<string, unknown>): MuseRichWidget[] {
  const bags: unknown[] = []
  for (const key of ['widgets', 'presentations', 'presentation']) {
    const v = payload[key]
    if (Array.isArray(v)) bags.push(...v)
    else if (v && typeof v === 'object') bags.push(v)
  }
  for (const parentKey of ['data', 'transcript']) {
    const nested = asObj(payload[parentKey])
    if (!nested) continue
    for (const key of ['widgets', 'presentations', 'presentation']) {
      const v = nested[key]
      if (Array.isArray(v)) bags.push(...v)
      else if (v && typeof v === 'object') bags.push(v)
    }
    const msgs = nested['messages']
    if (Array.isArray(msgs)) {
      for (const m of msgs) {
        const mm = asObj(m)
        const content = mm && Array.isArray(mm['content']) ? mm['content'] : []
        for (const item of content) {
          const cc = asObj(item)
          if (!cc) continue
          const cType = museString(cc['type'] || cc['kind'])
          if (cType && cType !== 'text' && cType !== 'markdown' && cType !== 'image' && cType !== 'file') {
            bags.push(cc)
          }
        }
      }
    }
  }
  const out: MuseRichWidget[] = []
  const seenWidgetIds = new Set<string>()
  for (const raw of bags) {
    const w = asObj(raw)
    if (!w) continue
    const kind = museString(w['kind'] || w['widget_kind'] || w['widgetKind'] || w['type'])
    const widgetId = museString(w['widget_id'] || w['widgetId'] || w['presentation_id'] || w['id'] || `${kind}-${out.length}`)
    if (seenWidgetIds.has(widgetId)) continue
    seenWidgetIds.add(widgetId)
    const data = asObj(w['data']) || w
    if (kind === 'shopping_results' || kind === 'shopping_results_v2') {
      const productsRaw = data['products']
      const products: Array<{
        name: string
        url?: string
        imageUrl?: string
        price?: string
        retailer?: string
      }> = []
      if (Array.isArray(productsRaw)) {
        for (const row of productsRaw) {
          const o = asObj(row)
          if (!o) continue
          const name = museString(o['product_name'] || o['productName'] || o['name'])
          if (!name) continue
          products.push({
            name,
            url: museString(o['url']) || undefined,
            imageUrl: museString(o['image_url'] || o['imageUrl']) || undefined,
            price: museString(o['price'] || o['line_price'] || o['linePrice']) || undefined,
            retailer: museString(o['retailer_name'] || o['retailerName'] || o['provider']) || undefined
          })
        }
      }
      if (products.length) out.push({ kind, widgetId, products: products.slice(0, 24) })
      continue
    }
    if (kind === 'shopping_cart') {
      const itemsRaw = data['items']
      const items: Array<{ id: string; name: string; quantity: number; imageUrl?: string; linePrice?: string }> = []
      if (Array.isArray(itemsRaw)) {
        for (const row of itemsRaw) {
          const o = asObj(row)
          if (!o) continue
          const id = museString(o['id'])
          const name = museString(o['name'])
          const quantity = o['quantity']
          if (!id || !name || typeof quantity !== 'number' || !(quantity > 0)) continue
          items.push({
            id,
            name,
            quantity,
            imageUrl: museString(o['image_url'] || o['imageUrl']) || undefined,
            linePrice: museString(o['line_price'] || o['linePrice']) || undefined
          })
        }
      }
      if (items.length) {
        out.push({
          kind: 'shopping_cart',
          widgetId,
          items: items.slice(0, 40),
          retailerName: museString(data['retailer_name'] || data['retailerName']) || undefined,
          subtotal: museString(data['subtotal']) || undefined
        })
      }
      continue
    }
    if (kind === 'local_map') {
      const html = museString(data['html']) || undefined
      const places: Array<{ id: string; name: string; latitude: number; longitude: number; category?: string }> = []
      const typed = asObj(data['typed_data'] || data['typedData'] || data['scene'])
      const elements = typed && Array.isArray(typed['elements']) ? typed['elements'] : data['elements']
      if (Array.isArray(elements)) {
        for (const row of elements) {
          const o = asObj(row)
          if (!o) continue
          const c = coord(o['coordinate'])
          const name = museString(o['name'])
          const id = museString(o['id'] || o['place_id'] || o['placeId'] || name)
          if (!c || !name) continue
          places.push({
            id,
            name,
            latitude: c.latitude,
            longitude: c.longitude,
            category: museString(o['category']) || undefined
          })
        }
      }
      if (html || places.length) out.push({ kind: 'local_map', widgetId, html, places: places.slice(0, 40) })
      continue
    }
    if (kind === 'marketplace_map') {
      const listings: Array<{
        id: string
        name: string
        url?: string
        price?: string
        imageUrl?: string
        latitude?: number
        longitude?: number
      }> = []
      const typed = asObj(data['typed_data'] || data['typedData'])
      const elements = typed && Array.isArray(typed['elements']) ? typed['elements'] : data['elements']
      if (Array.isArray(elements)) {
        for (const row of elements.slice(0, 24)) {
          const o = asObj(row)
          if (!o) continue
          const id = museString(o['id'] || o['listing_id'] || o['listingId'])
          const name = museString(o['name'])
          if (!id || !name) continue
          const c = o['coordinate'] != null ? coord(o['coordinate']) : null
          listings.push({
            id,
            name,
            url: museString(o['url']) || undefined,
            price: museString(o['price'] || o['sale_price'] || o['salePrice']) || undefined,
            imageUrl: museString(o['image_url'] || o['imageUrl']) || undefined,
            latitude: c?.latitude,
            longitude: c?.longitude
          })
        }
      }
      if (listings.length) out.push({ kind: 'marketplace_map', widgetId, listings })
      continue
    }
    if (kind === 'html') {
      const html = museString(data['html'])
      if (html.trim()) {
        out.push({
          kind: 'html',
          widgetId,
          html: html.slice(0, 200_000),
          downloadable: data['downloadable'] === true
        })
      }
      continue
    }
    if (kind === 'slides') {
      const deck = asObj(data['deck']) || data
      const label = museString(deck['label'] || data['label'] || data['display_text'] || 'Slides')
      const slug = museString(data['slug'])
      const path = museString(deck['path'] || data['path']) || undefined
      if (slug) out.push({ kind: 'slides', widgetId, label, slug, path })
      continue
    }
    if (kind === 'image_options') {
      const imagesRaw = data['images']
      const images: Array<{ path: string; imageId?: string }> = []
      if (Array.isArray(imagesRaw)) {
        for (const row of imagesRaw) {
          const o = asObj(row)
          if (!o) continue
          const path = trimStr(o['path'])
          if (!path) continue
          const imageId = museString(o['image_id'] || o['imageId']) || undefined
          images.push(imageId ? { path, imageId } : { path })
        }
      }
      if (!images.length) continue
      const state = asObj(w['state']) || {}
      const stateData = asObj(state['data']) || {}
      const selectedPath = museString(stateData['selectedPath'] || state['selectedPath']) || null
      const selectedIndices = Array.isArray(stateData['selectedIndices'])
        ? (stateData['selectedIndices'] as unknown[]).filter((n): n is number => typeof n === 'number')
        : Array.isArray(state['selectedIndices'])
          ? (state['selectedIndices'] as unknown[]).filter((n): n is number => typeof n === 'number')
          : []
      out.push({
        kind: 'image_options',
        widgetId,
        images: images.slice(0, 12),
        multiSelect: data['multi_select'] === true || data['multiSelect'] === true,
        selectedPath,
        selectedIndices,
        baseVersion: Number(state['version'] ?? w['version'] ?? 0) || 0
      })
      continue
    }
    if (kind === 'text_with_button') {
      const inner = asObj(data['textWithButton'] || data['text_with_button']) || data
      const text = museString(inner['text'] || inner['markdown'] || inner['body'] || inner['content'] || w['display_text'] || w['title'])
      const btnsRaw = inner['buttons'] ?? inner['actions'] ?? (inner['button'] ? [inner['button']] : [])
      const buttons: Array<{ label: string; actionText?: string; url?: string; command?: string }> = []
      if (Array.isArray(btnsRaw)) {
        for (const row of btnsRaw) {
          const b = asObj(row)
          if (!b) continue
          const label = museString(b['label'] || b['title'] || b['text'])
          if (!label) continue
          buttons.push({
            label,
            actionText: museString(b['send_text'] || b['sendText'] || b['message'] || b['prompt']) || undefined,
            url: museString(b['url'] || b['href']) || undefined,
            command: museString(b['command'] || b['action']) || undefined
          })
        }
      }
      if (text || buttons.length) {
        out.push({ kind: 'text_with_button', widgetId, text, buttons: buttons.slice(0, 8) })
      }
      continue
    }
    if (kind === 'generic_list') {
      const itemsRaw = data['items'] ?? data['rows'] ?? data['elements']
      const items: Array<{ id: string; title: string; subtitle?: string; sendText?: string; url?: string }> = []
      if (Array.isArray(itemsRaw)) {
        for (const row of itemsRaw.slice(0, 30)) {
          const o = asObj(row)
          if (!o) continue
          const rowData = asObj(o['data']) || o
          const title = museString(o['title'] || o['label'] || o['name'] || rowData['title'] || rowData['text'])
          if (!title) continue
          const id = museString(o['id'] || rowData['id'] || `${widgetId}-${items.length}`)
          const typ = museString(o['type'] || o['kind'])
          const sendText =
            typ === 'send_message'
              ? museString(rowData['text'] || rowData['message'] || title)
              : museString(o['send_text'] || o['sendText'] || rowData['send_text']) || undefined
          items.push({
            id,
            title,
            subtitle: museString(o['subtitle'] || o['description'] || rowData['subtitle']) || undefined,
            sendText: sendText || undefined,
            url: museString(o['url'] || rowData['url']) || undefined
          })
        }
      }
      if (items.length) {
        out.push({
          kind: 'generic_list',
          widgetId,
          title: museString(data['title'] || w['title'] || w['display_text']) || undefined,
          items
        })
      }
      continue
    }
    if (kind === 'voice_options') {
      const optsRaw = data['options'] ?? data['voices'] ?? data['items']
      const voices: Array<{ id: string; name: string; description?: string; selected?: boolean }> = []
      const state = asObj(w['state']) || {}
      const stateData = asObj(state['data']) || {}
      const selectedId = museString(stateData['selectedVoiceId'] || stateData['voiceId'] || data['selected_voice_id'])
      if (Array.isArray(optsRaw)) {
        for (const row of optsRaw.slice(0, 20)) {
          const o = asObj(row)
          if (!o) continue
          const id = museString(o['id'] || o['voice_id'] || o['voiceId'] || o['name'])
          const name = museString(o['name'] || o['label'] || o['title'] || id)
          if (!name) continue
          voices.push({
            id: id || name,
            name,
            description: museString(o['description'] || o['subtitle'] || o['style']) || undefined,
            selected: Boolean(o['selected'] || (selectedId && id === selectedId))
          })
        }
      }
      if (voices.length) {
        out.push({ kind: 'voice_options', widgetId, voices })
      }
      continue
    }
    if (
      kind === 'markdown' ||
      kind === 'document' ||
      kind === 'report' ||
      kind === 'artifact' ||
      kind === 'text_document'
    ) {
      const md = museString(
        data['markdown'] ||
          data['content'] ||
          data['text'] ||
          data['body'] ||
          w['markdown'] ||
          w['content'] ||
          w['display_text']
      )
      const path = museString(data['path'] || data['file_path'] || w['path']) || undefined
      const title = museString(data['title'] || data['label'] || data['filename'] || w['title']) || undefined
      if (md.trim() || path) {
        out.push({
          kind: 'markdown',
          widgetId,
          title,
          markdown: md.slice(0, 150_000),
          path
        })
      }
      continue
    }
    if (kind === 'hotel_results' || kind === 'hotels' || kind === 'hotel_search_results') {
      const hotelsRaw = data['hotels'] ?? data['results'] ?? data['items']
      const hotels: Array<{
        name: string
        price?: string
        rating?: string
        url?: string
        imageUrl?: string
        location?: string
      }> = []
      if (Array.isArray(hotelsRaw)) {
        for (const row of hotelsRaw.slice(0, 20)) {
          const o = asObj(row)
          if (!o) continue
          const name = museString(o['name'] || o['hotel_name'] || o['title'])
          if (!name) continue
          hotels.push({
            name,
            price: museString(o['price'] || o['rate'] || o['price_label'] || o['total_price']) || undefined,
            rating: museString(o['rating'] || o['stars'] || o['review_score']) || undefined,
            url: museString(o['url'] || o['booking_url'] || o['deeplink']) || undefined,
            imageUrl: museString(o['image_url'] || o['imageUrl'] || o['thumbnail']) || undefined,
            location: museString(o['location'] || o['neighborhood'] || o['address']) || undefined
          })
        }
      }
      if (hotels.length) {
        out.push({ kind: 'hotel_results', widgetId, hotels })
      }
      continue
    }
    if (kind === 'idea_cards' || kind === 'ideas' || kind === 'idea_card') {
      const cardsRaw = data['cards'] ?? data['ideas'] ?? data['items'] ?? [data]
      const cards: Array<{ id: string; title: string; subtitle?: string; prompt?: string }> = []
      if (Array.isArray(cardsRaw)) {
        for (const row of cardsRaw.slice(0, 16)) {
          const o = asObj(row)
          if (!o) continue
          const title = museString(o['title'] || o['headline'] || o['name'] || o['text'])
          if (!title) continue
          cards.push({
            id: museString(o['id'] || o['idea_card_id'] || `${widgetId}-${cards.length}`),
            title,
            subtitle: museString(o['subtitle'] || o['description'] || o['category']) || undefined,
            prompt: museString(o['prompt'] || o['send_text'] || o['query'] || title) || undefined
          })
        }
      }
      if (cards.length) {
        out.push({ kind: 'idea_cards', widgetId, cards })
      }
      continue
    }
    if (/vault|credential|secret|password|auth_card|login_card|secure_storage|account_login/i.test(kind)) {
      const stateObj = asObj(w['state']) || {}
      const stateData = asObj(stateObj['data']) || {}
      const domain = museString(data['domain'] || data['host'] || data['service'] || data['site'] || w['domain'])
      const rawStatus = museString(
        stateData['status'] || stateObj['status'] || data['status'] || data['state'] || w['status']
      ).toLowerCase()
      const saved =
        Boolean(stateData['saved'] || stateData['logged_in'] || data['saved'] || data['is_saved']) ||
        /saved|logged_in|completed|done|authenticated/i.test(rawStatus)
      out.push({
        kind: 'session_card',
        widgetId,
        cardType: 'vault',
        title: museString(data['title'] || w['title']) || (domain ? `安全存储 · ${domain}` : '安全存储'),
        subtitle:
          museString(data['subtitle'] || data['description'] || w['display_text']) ||
          (saved ? '登录信息已保存' : '在内置安全页面填写凭据，密码不会发到聊天记录'),
        status: saved ? '已登录' : '待填写',
        url: museString(data['url'] || data['login_url'] || w['url']) || undefined,
        actionLabel: saved ? '查看安全存储' : museString(data['cta_label'] || data['button_label']) || '打开安全卡片'
      })
      continue
    }
  }
  return out
}

export type RemoteCardType = 'browser' | 'computer'
type RemoteSessionCard = Extract<MuseRichWidget, { kind: 'session_card' }> & { cardType: RemoteCardType }
const TOOL_EVENT = /^(?:delta\.tool_|tool_(?:call|use|result)(?:[.:_]|$))/i
const REMOTE_FIELDS = ['browser', 'computer', 'browser_use', 'computer_use', 'browserTask', 'browser_task', 'live_view']
const PREVIEW_FIELDS = ['preview', 'latest_preview', 'latestPreview', 'screenshot', 'latest_screenshot', 'latestScreenshot']
const REMOTE_TASK_IDS = ['task_id', 'taskId', 'browser_task_id', 'browserTaskId', 'active_task_id', 'latest_task_id']
const REMOTE_HASHES = ['sha256', 'preview_sha256', 'previewSha256', 'hash', 'image_hash', 'imageHash']
const COMPUTER_PREVIEW_PATH = /\/computer\/previews\/([^/?#]+)\/([^/?#]+)/
// Rich widgets are persisted in local chat history. Prefer the RPC reference for larger frames.
const MAX_EMBEDDED_PREVIEW_CHARS = 256 * 1024
const EMBEDDED_PREVIEW = /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/i
const TASK_FIELDS = ['task', 'active_task', 'activeTask', 'latest_task', 'latestTask', 'browserTask', 'browser_task']
const REMOTE_DETAIL_FIELDS = new Set([
  'payload', 'result', 'output', 'data', 'widget', 'ui_widget', 'state', 'metadata', 'content',
  ...TASK_FIELDS, ...REMOTE_FIELDS, ...PREVIEW_FIELDS, 'image', 'source', 'tool', 'tool_use', 'tool_result', 'function', 'input', 'arguments', 'args'
])
const REMOTE_CONTAINERS = [
  'payload', 'data', 'message', 'transcript', 'messages', 'content', 'items', 'blocks',
  'widgets', 'widget', 'ui_widget', 'presentations', 'presentation', 'tool_calls', 'toolCalls', 'tool_use',
  'tool_call', 'tool_result', 'result', 'output', 'metadata', ...REMOTE_FIELDS
]

function remoteCardType(value: unknown): RemoteCardType | undefined {
  const name = museString(value).replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase().replace(/[.\s:/-]+/g, '_')
  if (/(?:^|_)browser(?:_|$)|^(?:open_url|navigate(?:_to)?|remote_view|live_view)(?:_|$)/.test(name)) return 'browser'
  if (/(?:^|_)(?:computer|desktop)(?:_|$)|^(?:vm_view|screen|screenshot)(?:_|$)/.test(name)) return 'computer'
  return undefined
}

function isRunningRemoteStatus(status?: string): boolean {
  return /^(?:正在工作|running|working|active|in[ _-]progress|pending|queued)$/i.test(status ?? '')
}

function firstField(records: ReadonlyArray<Record<string, unknown> | null>, ...keys: string[]): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = trimStr(record?.[key])
      if (value) return value
    }
  }
  return undefined
}

export function assistantMessageId(record: Record<string, unknown>): string {
  return firstField([record], 'message_id', 'assistant_message_id') ||
    firstField([asObj(record['message'])], 'message_id', 'id') || ''
}

function structuredToolData(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const json = value.trim()
  if (json.length > 262_144 || !/^[{\[]/.test(json)) return undefined
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

function remoteCardTitle(type: RemoteCardType): string {
  return type === 'computer' ? '云端电脑' : 'Browser'
}

function embeddedPreview(records: Record<string, unknown>[], previewUrl?: string): string | undefined {
  for (const record of records) {
    const source = firstField([record], 'dataUrl', 'data_url', 'image_url', 'imageUrl', 'src') || previewUrl
    if (source && source.length <= MAX_EMBEDDED_PREVIEW_CHARS && EMBEDDED_PREVIEW.test(source)) {
      return source
    }
    const data = firstField([record], 'dataBase64', 'data_base64', 'imageBase64', 'image_base64', 'base64', 'png_base64', 'jpeg_base64')
    if (!data || data.length > MAX_EMBEDDED_PREVIEW_CHARS) continue
    const src = extractInlineImageUri({ ...record, data_base64: data }, firstField([record], 'contentType', 'content_type'))
    if (EMBEDDED_PREVIEW.test(src)) return src
  }
  return undefined
}

function remoteSessionCard(record: Record<string, unknown>, type: RemoteCardType, source: string, toolId?: string): RemoteSessionCard {
  const details: Array<Record<string, unknown>> = []
  const tasks: Array<Record<string, unknown>> = []
  const previews: Array<Record<string, unknown>> = []
  let directScreenshot: string | undefined
  const collect = (raw: unknown, key: string, depth: number): void => {
    if (depth > 8) return
    if (typeof raw === 'string' && PREVIEW_FIELDS.includes(key) && raw.length <= MAX_EMBEDDED_PREVIEW_CHARS) {
      if (!directScreenshot && EMBEDDED_PREVIEW.test(raw)) directScreenshot = raw
      if (/screenshot/i.test(key) && /^(?:iVBORw0KGgo|\/9j\/|UklGR|R0lGOD)/.test(raw)) {
        directScreenshot ??= embeddedPreview([{ dataBase64: raw }])
      }
    }
    const value = structuredToolData(raw)
    if (Array.isArray(value)) {
      for (const item of value) collect(item, key, depth + 1)
      return
    }
    const entry = asObj(value)
    if (!entry) return
    if (PREVIEW_FIELDS.includes(key) || key === 'image' || key === 'source') previews.push(entry)
    else if (TASK_FIELDS.includes(key)) tasks.push(entry)
    else details.push(entry)
    for (const field of REMOTE_DETAIL_FIELDS) {
      collect(entry[field], field, depth + 1)
    }
    if (entry['type'] === 'text' && key === 'content') collect(entry['text'], key, depth + 1)
  }
  collect(record, '', 0)
  const page = [...tasks, ...details]
  const taskId = firstField(page, ...REMOTE_TASK_IDS) || firstField(tasks, 'id') || firstField(previews, ...REMOTE_TASK_IDS)
  const matchingPreviews = previews.filter((preview) => {
    const owner = firstField([preview], ...REMOTE_TASK_IDS)
    return !taskId || !owner || owner === taskId
  })
  const rawStatus = firstField(page, 'status', 'state') ||
    (details.some((detail) => detail['is_error'] === true || detail['success'] === false) ? 'Failed' :
      /(?:start(?:ed)?|tool_use)$/.test(source) ? 'running' : /(?:done|completed|tool_result)$/.test(source) ? 'Completed' : '')
  const previewUrl = firstField(matchingPreviews, 'url')
  const imageUrl = firstField([...matchingPreviews, ...page], 'image_url', 'imageUrl', 'screenshot_url', 'preview_url') ||
    (/\.(?:png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(previewUrl ?? '') ? previewUrl : undefined)
  const directUrl = firstField(page, 'url')
  const previewPath = COMPUTER_PREVIEW_PATH.exec(imageUrl ?? previewUrl ?? directUrl ?? '')
  const url = firstField([...page, ...matchingPreviews], 'current_url', 'currentUrl', 'page_url', 'pageUrl') ||
    (directUrl && !COMPUTER_PREVIEW_PATH.test(directUrl) ? directUrl : undefined) ||
    (!previewPath && previewUrl !== imageUrl ? previewUrl : undefined)
  const id = firstField([record, asObj(record['widget'] ?? record['ui_widget'])], 'widget_id', 'widgetId', 'presentation_id') ||
    (!TOOL_EVENT.test(source) ? firstField([record], 'id') : undefined)
  const resolvedTaskId = taskId || (previewPath ? previewPath[1] : undefined)
  const suffix = resolvedTaskId || toolId
  const hash = firstField([...matchingPreviews, ...page], ...REMOTE_HASHES) ||
    (previewPath && (!taskId || taskId === previewPath[1]) ? previewPath[2] : undefined)
  return {
    kind: 'session_card',
    widgetId: id || `muse-${type}${suffix ? `-${suffix}` : ''}`,
    cardType: type,
    title: firstField([...page, ...matchingPreviews], 'title', 'page_title') || remoteCardTitle(type),
    subtitle: firstField(page, 'subtitle', 'description') || firstField(matchingPreviews, 'title'),
    status: isRunningRemoteStatus(rawStatus) ? '正在工作' :
      /^(?:waiting|waiting_for_input|paused|needs_approval)$/i.test(rawStatus) ? '等待你操作' : rawStatus || undefined,
    url: url && /^https?:\/\//i.test(url) ? url : undefined,
    taskId: resolvedTaskId,
    previewSha256: hash,
    previewSrc: !previewPath && imageUrl && /^https?:\/\//i.test(imageUrl) ? imageUrl :
      resolvedTaskId && hash ? undefined : directScreenshot ?? embeddedPreview([...matchingPreviews, ...page], previewUrl),
    actionLabel: firstField(page, 'cta_label', 'button_label', 'actionLabel')
  }
}

function isRemoteSessionCard(widget: MuseRichWidget): widget is RemoteSessionCard {
  return widget.kind === 'session_card' && widget.cardType !== 'vault'
}

function mergeRemoteCard(cards: RemoteSessionCard[], next: RemoteSessionCard): void {
  // A tool start often arrives without a task ID. Fold it into the later presentation.
  const index = cards.findIndex((card) => {
    if (card.taskId && next.taskId) return card.taskId === next.taskId
    if (card.widgetId === next.widgetId) return true
    if (card.previewSha256 && next.previewSha256) return card.previewSha256 === next.previewSha256
    return card.cardType === next.cardType
  })
  const prev = cards[index]
  if (!prev) {
    const widgetId = cards.some((card) => card.widgetId === next.widgetId) && next.taskId
      ? `${next.widgetId}-${next.taskId}` : next.widgetId
    cards.push({ ...next, widgetId })
    return
  }
  cards[index] = {
    ...prev,
    title: next.title === remoteCardTitle(next.cardType) ? prev.title : next.title,
    subtitle: next.subtitle ?? prev.subtitle,
    status: isRunningRemoteStatus(next.status) && !next.taskId && prev.status && !isRunningRemoteStatus(prev.status)
      ? prev.status : next.status ?? prev.status,
    url: next.url ?? prev.url,
    taskId: next.taskId ?? prev.taskId,
    previewSha256: next.previewSha256 ?? prev.previewSha256,
    previewSrc: next.previewSrc ?? (next.previewSha256 && next.previewSha256 !== prev.previewSha256 ? undefined : prev.previewSrc),
    actionLabel: next.actionLabel ?? prev.actionLabel
  }
}

export function mergeRichWidgets(previous: MuseRichWidget[] | undefined, next: MuseRichWidget[]): MuseRichWidget[] {
  if (!previous?.length) return next
  if (!next.length) return previous
  const remote = previous.filter(isRemoteSessionCard)
  const other = next.filter((widget) => !isRemoteSessionCard(widget))
  for (const widget of next.filter(isRemoteSessionCard)) mergeRemoteCard(remote, widget)
  return [...(other.length ? other : previous.filter((widget) => !isRemoteSessionCard(widget))), ...remote]
}

function toolDetails(record: Record<string, unknown>): Record<string, unknown> {
  return asObj(record['tool_use'] ?? record['tool_result'] ?? record['tool_call'] ?? record['tool']) ?? {}
}

export function remoteToolId(record: Record<string, unknown>, source: string): string | undefined {
  const fields = [record, toolDetails(record)]
  return firstField(fields, 'tool_id', 'toolId', 'tool_use_id', 'toolUseId', 'tool_call_id', 'toolCallId', 'call_id') ||
    (TOOL_EVENT.test(source) ? firstField(fields, 'id') : undefined)
}

function parseRemoteSessionCards(
  payload: Record<string, unknown>,
  eventName = '',
  toolTypes = new Map<string, RemoteCardType>()
): RemoteSessionCard[] {
  const cards: RemoteSessionCard[] = []
  const visit = (raw: unknown, source: string, depth: number, toolContent = false): void => {
    if (depth > 10) return
    if (Array.isArray(raw)) {
      for (const item of raw) visit(item, source, depth + 1, toolContent)
      return
    }
    const record = asObj(raw)
    if (!record) return
    if (record['role'] === 'user' || record['role'] === 'system') return
    if (source === 'content' && record['type'] === 'text') {
      if (toolContent) visit(structuredToolData(record['text']), source, depth + 1, true)
      return
    }
    const tag = firstField([record], 'widget_kind', 'widgetKind', 'kind', 'type', 'event_name', 'event') || source
    const toolSource = TOOL_EVENT.test(tag) ? tag : source
    const toolId = remoteToolId(record, toolSource)
    const tool = TOOL_EVENT.test(toolSource) || Boolean(toolId)
    const data = asObj(record['data']) ?? {}
    const call = toolDetails(record)
    const descriptor = firstField([record, call, data], 'card_type', 'cardType', 'tool_type', 'toolType', 'widget_type', 'widgetType') ||
      (tag === 'ui_widget' ? firstField([asObj(record['widget']), data], 'kind', 'widget_kind', 'type') : undefined)
    const name = tool || tag === 'ui_widget'
      ? firstField([record, asObj(record['function']), call, asObj(call['function']), data], 'name', 'tool_name', 'toolName') : undefined
    const type = remoteCardType(descriptor) ?? (toolId ? toolTypes.get(toolId) : undefined) ?? remoteCardType(name) ??
      remoteCardType(tag) ?? remoteCardType(source)
    if (type && !/vault|credential|password|login_card|secure_storage/i.test(tag)) {
      if (toolId) toolTypes.set(toolId, type)
      mergeRemoteCard(cards, remoteSessionCard(record, type, tool ? toolSource : tag, toolId))
      return
    }
    for (const key of REMOTE_CONTAINERS) {
      const value = key === 'content' && (tool || toolContent) ? structuredToolData(record[key]) : record[key]
      visit(value, key === 'tool_calls' || key === 'toolCalls' ? 'tool_call' : key, depth + 1, tool || toolContent)
    }
    if (tool) visit(record['tool'], 'tool_call', depth + 1)
  }
  visit(payload, eventName, 0)
  return cards
}

/** Read-only widgets can be presentations, content blocks, or browser tool calls. */
export function parseRichWidgets(
  payload: Record<string, unknown>, eventName?: string, toolTypes?: Map<string, RemoteCardType>
): MuseRichWidget[] {
  return [...parsePresentationWidgets(payload), ...parseRemoteSessionCards(payload, eventName, toolTypes)]
}

export function parseToolCall(
  eventName: string,
  payload: Record<string, unknown>,
  messageId: string,
  displayText?: string
): MuseToolCall | null {
  const started = /(?:start(?:ed)?|tool_use)$/.test(eventName)
  const tool = toolDetails(payload)
  const fields = [payload, tool, asObj(payload['function']), asObj(tool['function'])]
  const name = firstField(fields, 'name', 'tool_name', 'toolName') || 'tool_call'
  const toolType = firstField(fields, 'tool_type', 'toolType')
  const id = remoteToolId(payload, eventName) || messageId || name
  let status: MuseToolCall['status'] = started ? 'running' : 'completed'
  if (!started) {
    const result = asObj(payload['result']) ?? {}
    if (result['success'] === false || payload['is_error'] === true || tool['is_error'] === true) status = 'errored'
  }
  const summary =
    (displayText && displayText.trim()) ||
    museString(payload['summary']) ||
    undefined
  return { id, name, toolType, status, summary }
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)(?:[?#].*)?$/i

function isImageHint(path: string, mime?: string, explicitType?: string): boolean {
  if (explicitType && /image|photo|picture|img/i.test(explicitType)) return true
  if (mime && mime.toLowerCase().startsWith('image/')) return true
  if (/^data:image\//i.test(path)) return true
  return IMAGE_EXT_RE.test(path)
}

function normalizeMediaPath(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  if (/^data:/i.test(s) || /^https?:\/\//i.test(s)) return s
  const noFileScheme = s.replace(/^file:\/\//i, '')
  const strippedFs = noFileScheme.replace(/^\/?fs\/raw\//i, '')
  // Keep workspace/... canonical if present inside an absolute VM path (/home/muse/workspace/...)
  const wsIdx = strippedFs.search(/(?:^|\/)workspace\//i)
  if (wsIdx >= 0) {
    return strippedFs.slice(wsIdx).replace(/^\/+/, '')
  }
  return strippedFs.replace(/^\/+/, '')
}

function extractInlineImageUri(o: Record<string, unknown>, fallbackMime?: string): string {
  const b64 = trimStr(o['data_base64'] || o['dataBase64'] || o['base64'] || o['b64_json'] || o['data'])
  if (!b64) return ''
  if (/^data:image\//i.test(b64)) return b64
  // Only treat strings that look like real base64 payloads (avoid short JSON/text fields)
  if (b64.length >= 64 && /^[A-Za-z0-9+/=\s]+$/.test(b64)) {
    const cleanB64 = b64.replace(/\s+/g, '')
    const mime =
      museString(o['mime_type'] || o['mimeType'] || o['media_type']) ||
      fallbackMime ||
      (cleanB64.startsWith('iVBORw0KGgo')
        ? 'image/png'
        : cleanB64.startsWith('/9j/')
          ? 'image/jpeg'
          : cleanB64.startsWith('UklGR')
            ? 'image/webp'
            : cleanB64.startsWith('R0lGOD')
              ? 'image/gif'
              : 'image/png')
    return `data:${mime};base64,${cleanB64}`
  }
  return ''
}

export function parseMediaParts(payload: Record<string, unknown>): MuseMediaPart[] {
  const out: MuseMediaPart[] = []
  const seen = new Set<string>()
  const push = (kind: 'image' | 'file', rawPath: string, extra?: Partial<MuseMediaPart>) => {
    const p = normalizeMediaPath(rawPath)
    if (!p || seen.has(p)) return
    seen.add(p)
    const effectiveKind: 'image' | 'file' =
      kind === 'image' || isImageHint(p, extra?.mimeType) ? 'image' : 'file'
    const name = extra?.name || (/^data:/i.test(p) ? 'image.png' : p.split('/').pop()?.split('?')[0] || p)
    out.push({
      kind: effectiveKind,
      path: p,
      name,
      imageId: extra?.imageId,
      mimeType: extra?.mimeType
    })
  }

  const inspectObject = (raw: unknown, depth = 0) => {
    if (depth > 4 || !raw) return
    if (typeof raw === 'string') {
      if (IMAGE_EXT_RE.test(raw) && (/^https?:\/\//i.test(raw) || raw.includes('/'))) {
        push('image', raw)
      }
      return
    }
    if (Array.isArray(raw)) {
      for (const item of raw) inspectObject(item, depth + 1)
      return
    }
    const c = asObj(raw)
    if (!c) return

    const typ = museString(c['type'] || c['kind'] || c['widget_kind'] || c['widgetKind']).toLowerCase()
    // Rich widgets that render their own images in RichWidgets shouldn't duplicate as standalone MediaParts.
    if (
      typ === 'shopping_results' ||
      typ === 'shopping_results_v2' ||
      typ === 'shopping_cart' ||
      typ === 'marketplace_map' ||
      typ === 'hotel_results' ||
      typ === 'image_options'
    ) {
      return
    }
    const mime = museString(c['mime_type'] || c['mimeType'] || c['media_type'] || c['content_type'] || c['mime']) || undefined
    const name = museString(c['filename'] || c['file_name'] || c['name'] || c['label'] || c['title']) || undefined
    const imageId = museString(c['image_id'] || c['imageId']) || undefined

    // Explicit image / attachment / file objects
    const sourceObj = asObj(c['source'])
    const sourceMime = sourceObj ? museString(sourceObj['media_type'] || sourceObj['mime_type'] || sourceObj['mimeType']) || mime : mime
    const sourcePath = sourceObj
      ? museString(sourceObj['url'] || sourceObj['path']) || extractInlineImageUri(sourceObj, sourceMime)
      : ''
    const fileRefObj = asObj(c['file_ref'] ?? c['fileRef'])
    const fileRefPath = fileRefObj
      ? museString(fileRefObj['path'] || fileRefObj['file_path'] || fileRefObj['url'])
      : ''
    const directPath =
      museString(c['path'] || c['file_path'] || c['filePath'] || c['image_path'] || c['imagePath'] || c['output_path'] || c['outputPath'] || c['artifact_path']) ||
      fileRefPath ||
      museString(c['image_url'] || c['imageUrl'] || c['url'] || c['uri'] || c['src']) ||
      sourcePath ||
      extractInlineImageUri(c, mime)

    if (
      typ === 'image' ||
      typ === 'image_url' ||
      typ === 'generated_image' ||
      typ === 'photo' ||
      typ === 'media'
    ) {
      const nestedImgUrl = asObj(c['image_url'])
      const nestedUrl = nestedImgUrl ? museString(nestedImgUrl['url']) : ''
      const p = directPath || nestedUrl
      if (p) push('image', p, { imageId, mimeType: sourceMime, name })
    } else if (
      typ === 'file' ||
      typ === 'file_ref' ||
      typ === 'attachment' ||
      typ === 'artifact' ||
      typ === 'audio' ||
      typ === 'video'
    ) {
      const p = directPath || museString(c['filename'])
      if (p) {
        const effMime =
          sourceMime || (typ === 'audio' ? 'audio/*' : typ === 'video' ? 'video/*' : undefined)
        push(isImageHint(p, effMime, typ) ? 'image' : 'file', p, { name, mimeType: effMime, imageId })
      }
    } else if (directPath && (isImageHint(directPath, sourceMime, typ) || museString(c['file_type']) === 'image')) {
      // Untyped attachment/image object carrying an image path/URL (e.g. inside images[] or attachments[])
      push('image', directPath, { imageId, mimeType: sourceMime, name })
    } else if (directPath && sourceMime) {
      // GOXF (02712a8): a file presentation's data.file ({ mime: 'application/pdf', path: 'sandbox://workspace/…' }).
      push('file', directPath, { mimeType: sourceMime })
    }

    // Parse JSON-encoded tool_result content strings (e.g. {"path":"workspace/out.png"})
    if (typ === 'tool_result' && typeof c['content'] === 'string') {
      const rawContent = (c['content'] as string).trim()
      if (rawContent.length <= 262_144 && (rawContent.startsWith('{') || rawContent.startsWith('['))) {
        try {
          inspectObject(JSON.parse(rawContent), depth + 1)
        } catch {
          /* ignore non-JSON tool result text */
        }
      }
    }

    // Recurse into known container keys (never walk arbitrary text fields)
    for (const key of [
      'content',
      'items',
      'images',
      'generated_images',
      'attachments',
      'files',
      'media',
      'artifacts',
      'resources',
      'image',
      'file',
      'file_ref',
      'fileRef',
      'source',
      'data',
      'presentation',
      'presentations',
      'widgets',
      'result',
      'output',
      'outputs',
      'metadata'
    ]) {
      if (c[key] !== undefined && c[key] !== null && typeof c[key] === 'object') {
        inspectObject(c[key], depth + 1)
      }
    }

    // file_paths[] arrays (tool result metadata)
    const filePaths = c['file_paths'] ?? c['filePaths'] ?? c['image_paths'] ?? c['imagePaths']
    if (Array.isArray(filePaths)) {
      const ft = museString(c['file_type'] || c['fileType'])
      for (const fp of filePaths) {
        if (typeof fp === 'string' && fp.trim()) {
          push(ft === 'image' || isImageHint(fp) ? 'image' : 'file', fp)
        }
      }
    }
  }

  inspectObject(payload, 0)

  const transcript = asObj(payload['transcript'])
  if (transcript && Array.isArray(transcript['messages'])) {
    for (const msg of transcript['messages'] as unknown[]) {
      const mm = asObj(msg)
      if (!mm || mm['role'] === 'user') continue
      inspectObject(mm, 1)
    }
  }

  // Also capture inline Markdown workspace image references (`![alt](workspace/...)` or `![alt](/fs/raw/...)`)
  const textCandidates = [museString(payload['display_text']), museString(payload['text']), transcriptText(payload)]
  const mdImgRe = /!\[([^\]]*)\]\(([^)]+)\)/g
  for (const txt of textCandidates) {
    if (!txt || !txt.includes('![')) continue
    let m: RegExpExecArray | null
    while ((m = mdImgRe.exec(txt)) !== null) {
      const alt = m[1]?.trim() || undefined
      const url = m[2]?.trim() || ''
      if (url && (/^\/?(?:fs\/raw\/)?workspace\//i.test(url) || /^\/home\/[^/]+\/workspace\//i.test(url))) {
        push('image', url, { name: alt })
      }
    }
  }

  return out
}

/** Final assistant text from a delta.message_done transcript. */
export function transcriptText(payload: Record<string, unknown>): string {
  const t = asObj(payload['transcript']) ?? {}
  const msgs = Array.isArray(t['messages']) ? (t['messages'] as unknown[]) : []
  const out: string[] = []
  for (const m of msgs) {
    const mm = asObj(m) ?? {}
    if (mm['role'] && mm['role'] !== 'assistant') continue
    const content = Array.isArray(mm['content']) ? (mm['content'] as unknown[]) : []
    for (const c of content) {
      const cc = asObj(c) ?? {}
      const typ = museString(cc['type']).toLowerCase()
      if ((typ === 'text' || typ === 'markdown' || !typ) && typeof cc['text'] === 'string') {
        out.push(cc['text'] as string)
      } else if (typeof cc['markdown'] === 'string') {
        out.push(cc['markdown'] as string)
      }
    }
    if (!content.length && typeof mm['content'] === 'string') {
      out.push(mm['content'] as string)
    }
  }
  const cleaned = out
    .join('\n\n')
    .replace(/\[\[hatch_widget:[^\]]+\]\]/g, '')
    .trim()
  return cleaned
}

export function assistantTextFromPayload(p: Record<string, unknown>): string {
  const message = asObj(p['message']) ?? {}
  const content = p['content'] ?? message['content']
  const blockText = Array.isArray(content) ? content.map((part) => {
    const block = asObj(part) ?? {}
    const type = museString(block['type'] || block['kind'])
    return !type || type === 'text' || type === 'markdown' ? museString(block['text'] || block['markdown']) : ''
  }).filter(Boolean).join('\n\n') : ''
  const raw =
    transcriptText(p) ||
    museString(p['display_text']) ||
    museString(p['markdown']) ||
    museString(content) ||
    museString(p['text']) ||
    blockText ||
    museString(message['text'])
  return raw.replace(/\[\[hatch_widget:[^\]]+\]\]/g, '').trim()
}

/**
 * Never shrink a streaming bubble: keep `prev` unless `next` is a longer
 * version of it (superset/continuation). Used for reconnect + backfill.
 */
export function mergeMonotonic(prev: string, next: string): string {
  if (!next) return prev
  if (!prev) return next
  if (next.length <= prev.length) return prev
  if (next.startsWith(prev)) return next
  // Longer but diverging (e.g. whitespace/markdown normalisation) — still a
  // fuller copy of the reply, so take it; shorter copies are never taken.
  return next
}

export function parseMuseTimestampMs(
  e: Record<string, unknown>,
  p?: Record<string, unknown>
): number {
  const candidates: unknown[] = [
    e['occurred_at_ms'],
    e['created_at_ms'],
    e['ts_ms'],
    e['timestamp_ms'],
    e['sent_at_ms'],
    p?.['occurred_at_ms'],
    p?.['created_at_ms'],
    p?.['ts_ms'],
    p?.['timestamp_ms'],
    e['occurred_at'],
    e['created_at'],
    e['timestamp'],
    p?.['occurred_at'],
    p?.['created_at'],
    p?.['timestamp']
  ]
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      return v < 1e12 ? Math.round(v * 1000) : Math.round(v)
    }
    if (typeof v === 'string' && v.trim()) {
      const trimmed = v.trim()
      const asNum = Number(trimmed)
      if (Number.isFinite(asNum) && asNum > 0) {
        return asNum < 1e12 ? Math.round(asNum * 1000) : Math.round(asNum)
      }
      const parsed = Date.parse(trimmed)
      if (Number.isFinite(parsed) && parsed > 0) return parsed
    }
  }
  return 0
}

export interface HistoryRow {
  id: string
  text: string
  completed: boolean
  widgets?: MuseOptionWidget[]
  richWidgets?: MuseRichWidget[]
  media?: MuseMediaPart[]
  at?: number
  seq?: number
  parentId?: string
}

function extractRawHistoryEvents(raw: unknown): Array<Record<string, unknown>> {
  const root = asObj(raw) ?? {}
  const result = root['result']
  const r = asObj(result) ?? root
  const list = r['chat_events'] ?? r['events'] ?? r['messages'] ?? r['items'] ?? (Array.isArray(result) ? result : raw)
  if (!Array.isArray(list)) return []
  const indexed = list.map((item, index) => {
    const e = asObj(item) ?? {}
    const p = asObj(e['payload']) ?? {}
    return {
      e,
      at: parseMuseTimestampMs(e, p),
      seq: Number(e['seq'] ?? 0) || 0,
      index
    }
  })
  // Preserve chronological order if the server returned newest-first
  const firstKnown = indexed.find((x) => x.at > 0)
  const lastKnown = [...indexed].reverse().find((x) => x.at > 0)
  if (firstKnown && lastKnown && firstKnown.at > lastKnown.at) {
    indexed.reverse()
  } else if (indexed.some((x) => x.at > 0)) {
    indexed.sort((a, b) => {
      if (a.at > 0 && b.at > 0 && a.at !== b.at) return a.at - b.at
      if (a.seq > 0 && b.seq > 0 && a.seq !== b.seq) return a.seq - b.seq
      return a.index - b.index
    })
  }
  return indexed.map((x) => x.e)
}

function isAssistantHistoryEvent(name: string, payload: Record<string, unknown>): boolean {
  return !TOOL_EVENT.test(name) && (/assistant|message_done|presentation/i.test(name) ||
    payload['role'] === 'assistant' || asObj(payload['message'])?.['role'] === 'assistant')
}

/** Attach scoped browser events to their assistant message before either history pass reads it. */
function historyRichWidgets(list: Record<string, unknown>[]): Map<string, MuseRichWidget[]> {
  const byMessage = new Map<string, MuseRichWidget[]>()
  const toolTypes = new Map<string, RemoteCardType>()
  const toolMessages = new Map<string, string>()
  let lastAssistantId = ''
  let pending: MuseRichWidget[] = []
  const add = (id: string, widgets: MuseRichWidget[]) => {
    if (widgets.length) byMessage.set(id, mergeRichWidgets(byMessage.get(id), widgets))
  }
  const flush = () => {
    if (lastAssistantId) add(lastAssistantId, pending)
    pending = []
  }
  for (const [index, event] of list.entries()) {
    if (isUserHistoryEvent(event)) {
      flush()
      lastAssistantId = ''
      toolTypes.clear()
      toolMessages.clear()
      continue
    }
    const payload = { ...event, ...asObj(event['payload']) }
    const name = museString(event['event_name']) || museString(event['event']) || museString(event['type'])
    const explicitId = assistantMessageId(payload)
    const toolId = remoteToolId(payload, name)
    if (toolId && explicitId) toolMessages.set(toolId, explicitId)
    if (isAssistantHistoryEvent(name, payload)) {
      const id = explicitId || museString(event['id']) || `hist_${index + 1}`
      add(id, pending)
      pending = []
      add(id, parseRichWidgets(payload, name, toolTypes))
      for (const toolId of toolTypes.keys()) {
        if (!toolMessages.has(toolId)) toolMessages.set(toolId, id)
      }
      lastAssistantId = id
      continue
    }
    const widgets = parseRemoteSessionCards(payload, name, toolTypes)
    if (!widgets.length) continue
    const id = explicitId || (toolId ? toolMessages.get(toolId) : undefined)
    if (id) add(id, widgets)
    else pending = mergeRichWidgets(pending, widgets)
  }
  flush()
  return byMessage
}

/** Assistant rows from chat.history (`{ok,result:{events|chat_events|messages}}`), oldest first. */
export function historyAssistants(raw: unknown): HistoryRow[] {
  const list = extractRawHistoryEvents(raw)
  if (!list.length) return []
  const richByMessage = historyRichWidgets(list)
  const rows: Array<HistoryRow & { at: number }> = []
  let pendingToolMedia: MuseMediaPart[] = []
  for (const e of list) {
    const p = asObj(e['payload']) ?? {}
    const name = museString(e['event_name']) || museString(e['event']) || museString(e['type'])
    const role = museString(e['role']) || museString(p['role'])
    const mergedPayload = { ...e, ...p }
    if ((TOOL_EVENT.test(name) || /attachment|media|artifact/i.test(name)) && !/assistant/.test(name)) {
      const tm = parseMediaParts(mergedPayload)
      if (tm.length) pendingToolMedia.push(...tm)
      continue
    }
    if (!isAssistantHistoryEvent(name, mergedPayload)) {
      if (/message\.user/i.test(name) || role === 'user') pendingToolMedia = []
      continue
    }
    const text = assistantTextFromPayload(mergedPayload)
    const status = (museString(p['status']) || museString(e['status'])).toLowerCase()
    const w = parseOptionWidgets(mergedPayload)
    const id = assistantMessageId(mergedPayload) || museString(e['id'])
    const rw = richByMessage.get(id)
    const ownMedia = parseMediaParts(mergedPayload)
    const combinedMedia = [...pendingToolMedia, ...ownMedia]
    pendingToolMedia = []
    const dedupMedia: MuseMediaPart[] = []
    const seen = new Set<string>()
    for (const m of combinedMedia) {
      if (seen.has(m.path)) continue
      seen.add(m.path)
      dedupMedia.push(m)
    }
    rows.push({
      id,
      text,
      completed:
        status === 'completed' ||
        status === 'complete' ||
        status === 'done' ||
        status === 'finished' ||
        (!status && Boolean(text || w.length || rw?.length || dedupMedia.length)),
      widgets: w.length ? w : undefined,
      richWidgets: rw,
      media: dedupMedia.length ? dedupMedia : undefined,
      at: parseMuseTimestampMs(e, p),
      seq: Number(e['seq'] ?? p['seq'] ?? 0) || undefined,
      parentId: chatParentMessageId(mergedPayload) || undefined
    })
  }
  rows.sort((a, b) => a.at - b.at)
  return rows
}

/**
 * Filter `chat.history` strictly to assistant rows belonging to the active turn so
 * `reconcileFinal()` and reconnect `backfill()` NEVER dump historical messages below
 * the user's newest chat bubble.
 */
export function historyAssistantsAfterTurn(
  raw: unknown,
  opts: {
    ackUserMessageId?: string
    knownAssistantIds?: ReadonlySet<string>
    turnStartedAtMs: number
  }
): HistoryRow[] {
  const list = extractRawHistoryEvents(raw)
  if (!list.length) return []
  const known = opts.knownAssistantIds ?? new Set<string>()
  const ackId = (opts.ackUserMessageId || '').trim()
  const matchesAck = (row: HistoryRow) => !ackId || !row.parentId || row.parentId === ackId

  // Locate the user message that kicked off this turn, if present in chat.history.
  let userEventIndex = -1
  if (ackId) {
    for (let i = 0; i < list.length; i += 1) {
      const e = list[i]!
      const p = asObj(e['payload']) ?? {}
      if (isUserHistoryEvent(e) && (museString(e['message_id']) || museString(p['message_id']) || museString(e['id'])) === ackId) {
        userEventIndex = i
        break
      }
    }
  }

  // If the turn's user message is in history, only consider events strictly after it
  // (plus any assistant id already observed streaming in this turn).
  if (userEventIndex >= 0) {
    const after = list.slice(userEventIndex + 1)
    const nextUser = after.findIndex(isUserHistoryEvent)
    const afterRows = historyAssistants(nextUser < 0 ? after : after.slice(0, nextUser)).filter(matchesAck)
    const ids = new Set(afterRows.map((row) => row.id))
    if (known.size > 0) {
      for (const r of historyAssistants(list)) {
        if (known.has(r.id) && !ids.has(r.id) && matchesAck(r)) afterRows.push(r)
      }
    }
    return afterRows
  }

  // Fallback when ackUserMessageId isn't echoed in history:
  // ONLY accept assistant rows already seen in this turn, OR timestamped after turnStartedAtMs.
  const cutoff = opts.turnStartedAtMs - (ackId ? 0 : 15_000)
  return historyAssistants(list).filter((row) => {
    if (!row.id || !matchesAck(row)) return false
    if (known.has(row.id) || (ackId && row.parentId === ackId)) return true
    return typeof row.at === 'number' && row.at >= cutoff
  })
}

function isUserHistoryEvent(event: Record<string, unknown>): boolean {
  const payload = asObj(event['payload']) ?? {}
  return (event['event_name'] ?? event['event']) === 'message.user' || (event['role'] ?? payload['role']) === 'user'
}

export interface MuseHistoryMessage {
  id: string
  role: 'user' | 'bot'
  text: string
  createdAt: number
  widgets?: MuseOptionWidget[]
  richWidgets?: MuseRichWidget[]
  tools?: MuseToolCall[]
  media?: MuseMediaPart[]
}

function userTextFromPayload(p: Record<string, unknown>, e: Record<string, unknown>): string {
  const direct = museString(e['display_text'] || p['display_text'] || p['text'] || e['text'] || p['content'] || e['content'])
  if (direct) return direct
  const items = p['items'] ?? e['items']
  if (Array.isArray(items)) {
    const parts: string[] = []
    for (const it of items) {
      const o = asObj(it) ?? {}
      const t = museString(o['text'])
      if (t) parts.push(t)
    }
    if (parts.length) return parts.join('\n')
  }
  const t = asObj(p['transcript'] ?? e['transcript']) ?? {}
  const msgs = Array.isArray(t['messages']) ? t['messages'] : []
  for (const m of msgs) {
    const mm = asObj(m) ?? {}
    if (mm['role'] && mm['role'] !== 'user') continue
    const content = Array.isArray(mm['content']) ? mm['content'] : []
    const parts: string[] = []
    for (const c of content) {
      const cc = asObj(c) ?? {}
      if (typeof cc['text'] === 'string') parts.push(cc['text'] as string)
    }
    if (parts.length) return parts.join('\n')
  }
  return ''
}

function mergeMediaPartsDedup(
  a: MuseMediaPart[] | undefined,
  b: MuseMediaPart[] | undefined
): MuseMediaPart[] | undefined {
  if (!a?.length && !b?.length) return undefined
  const out: MuseMediaPart[] = []
  const byPath = new Map<string, number>()
  for (const list of [a, b]) {
    if (!list) continue
    for (const part of list) {
      const idx = byPath.get(part.path)
      if (idx === undefined) {
        byPath.set(part.path, out.length)
        out.push(part)
      } else {
        const cur = out[idx]!
        out[idx] = {
          ...cur,
          kind: cur.kind === 'image' || part.kind === 'image' ? 'image' : cur.kind,
          name: cur.name || part.name,
          mimeType: cur.mimeType || part.mimeType,
          imageId: cur.imageId || part.imageId
        }
      }
    }
  }
  return out.length ? out : undefined
}

/** Full conversation transcript from chat.history (both user and assistant turns), oldest first. */
export function parseHistoryTranscript(raw: unknown): MuseHistoryMessage[] {
  const list = extractRawHistoryEvents(raw)
  if (!list.length) return []
  const richByMessage = historyRichWidgets(list)
  const byId = new Map<string, MuseHistoryMessage & { seq: number; hasRealTs: boolean }>()
  let pendingToolMedia: MuseMediaPart[] = []
  let lastBotId: string | null = null
  const baseFallbackTs = Date.now() - (list.length + 60) * 1000
  let lastKnownTs = 0
  let idx = 0
  for (const e of list) {
    idx += 1
    const p = asObj(e['payload']) ?? {}
    const name = museString(e['event_name']) || museString(e['event']) || museString(e['type'])
    const roleRaw = museString(e['role']) || museString(p['role'])
    const isUser = /message\.user/i.test(name) || roleRaw === 'user'
    const mergedPayload = { ...e, ...p }
    const isAssistant = isAssistantHistoryEvent(name, mergedPayload)
    if (!isUser && !isAssistant) {
      const extraMedia = parseMediaParts(mergedPayload)
      if (extraMedia.length) {
        const rawRefId = assistantMessageId(mergedPayload)
        const existingBot = rawRefId ? byId.get(`muse_native_${rawRefId}`) : undefined
        if (existingBot && existingBot.role === 'bot') {
          existingBot.media = mergeMediaPartsDedup(existingBot.media, extraMedia)
        } else {
          pendingToolMedia = mergeMediaPartsDedup(pendingToolMedia, extraMedia) ?? []
        }
      }
      continue
    }
    const rawId = assistantMessageId(mergedPayload) || museString(e['id']) || `hist_${idx}`
    const id = isUser ? `muse_user_${rawId}` : `muse_native_${rawId}`
    const parsedTs = parseMuseTimestampMs(e, p)
    const hasRealTs = parsedTs > 0
    if (hasRealTs) {
      lastKnownTs = parsedTs
    }
    const at = hasRealTs ? parsedTs : lastKnownTs > 0 ? lastKnownTs + idx : baseFallbackTs + idx
    const seq = Number(e['seq'] ?? idx) || idx
    if (isUser) {
      // Flush any dangling media from the previous assistant turn before resetting for the next turn
      if (pendingToolMedia.length && lastBotId) {
        const prevBot = byId.get(lastBotId)
        if (prevBot) prevBot.media = mergeMediaPartsDedup(prevBot.media, pendingToolMedia)
      }
      pendingToolMedia = []
      const text = userTextFromPayload(p, e)
      if (!text) continue
      const prev = byId.get(id)
      byId.set(id, {
        id,
        role: 'user',
        text: prev ? mergeMonotonic(prev.text, text) : text,
        createdAt: prev?.hasRealTs ? prev.createdAt : hasRealTs ? at : prev?.createdAt ?? at,
        hasRealTs: Boolean(prev?.hasRealTs || hasRealTs),
        seq: prev?.seq ?? seq
      })
    } else {
      const text = assistantTextFromPayload(mergedPayload)
      const w = parseOptionWidgets(mergedPayload)
      const rw = richByMessage.get(rawId)
      const ownMedia = parseMediaParts(mergedPayload)
      const combinedMedia = mergeMediaPartsDedup(pendingToolMedia, ownMedia)
      pendingToolMedia = []
      if (!text && !w.length && !rw?.length && !combinedMedia?.length) continue
      const prev = byId.get(id)
      byId.set(id, {
        id,
        role: 'bot',
        text: prev ? mergeMonotonic(prev.text, text) : text,
        createdAt: prev?.hasRealTs ? prev.createdAt : hasRealTs ? at : prev?.createdAt ?? at,
        hasRealTs: Boolean(prev?.hasRealTs || hasRealTs),
        widgets: w.length ? w : prev?.widgets,
        richWidgets: rw,
        media: mergeMediaPartsDedup(prev?.media, combinedMedia),
        seq: prev?.seq ?? seq
      })
      lastBotId = id
    }
  }
  if (pendingToolMedia.length && lastBotId) {
    const prevBot = byId.get(lastBotId)
    if (prevBot) prevBot.media = mergeMediaPartsDedup(prevBot.media, pendingToolMedia)
  }
  const rows = [...byId.values()]
  rows.sort((a, b) => (a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.seq - b.seq))
  return rows.map(({ seq: _seq, hasRealTs: _hasRealTs, ...rest }) => rest)
}
