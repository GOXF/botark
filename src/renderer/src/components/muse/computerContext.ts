import type { MuseBridge } from '@shared/bridge'

export type ComputerContextSnap = {
  taskId?: string
  sha256?: string
  sessionId?: string
  status?: string
  url?: string
  interactionUrl?: string
  title?: string
  inlineSrc?: string
  raw: Record<string, unknown>
}

const PREVIEW_KEYS = ['preview', 'latest_preview', 'latestPreview', 'screenshot', 'latest_screenshot', 'latestScreenshot']
const ACTIVE_TASK_KEYS = ['active_task', 'activeTask', 'task', 'browser_task', 'browserTask']
const LATEST_TASK_KEYS = ['latest_task', 'latestTask']
const SESSION_KEYS = ['session_id', 'sessionId', 'thread_id', 'threadId', 'chat_session_id']
const TASK_ID_KEYS = ['task_id', 'taskId', 'browser_task_id', 'browserTaskId', 'active_task_id', 'latest_task_id']
const HASH_KEYS = ['sha256', 'preview_sha256', 'previewSha256', 'hash', 'image_hash', 'imageHash']

function asObj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function field(records: ReadonlyArray<Record<string, unknown>>, ...keys: string[]): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  return undefined
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value || !/^https?:\/\//i.test(value)) return undefined
  try {
    const url = new URL(value)
    return url.username || url.password ? undefined : value
  } catch {
    return undefined
  }
}

function imageMime(value: string | undefined): string | undefined {
  const mime = value?.split(';', 1)[0]?.trim().toLowerCase()
  return /^image\/(?:png|jpe?g|webp|gif|avif|bmp|x-icon)$/.test(mime ?? '') ? mime : undefined
}

function base64Image(data: string, mime?: string): string | undefined {
  const embedded = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(data)
  const base64 = (embedded?.[2] ?? data).replace(/\s/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return undefined
  const type = embedded ? imageMime(embedded[1]) : mime ?? (
    base64.startsWith('/9j/') ? 'image/jpeg' : base64.startsWith('UklGR') ? 'image/webp' :
      base64.startsWith('R0lGOD') ? 'image/gif' : 'image/png'
  )
  return type ? `data:${type};base64,${base64}` : undefined
}

/** The native gateway uses dataBase64, while hook and context responses may wrap the image. */
export function parseComputerPreview(raw: unknown, { allowUrl = true, nested = true } = {}): string | undefined {
  const fromBytes = (bytes: Uint8Array, mime?: string) => {
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
    }
    const base64 = btoa(binary)
    if (!mime && !/^(?:iVBORw0KGgo|\/9j\/|UklGR|R0lGOD|Qk)/.test(base64)) return undefined
    return base64Image(base64, mime)
  }
  const read = (value: unknown, depth: number, inheritedMime?: string): string | undefined => {
    if (depth > 8) return undefined
    if (typeof value === 'string') {
      const text = value.trim()
      if (httpUrl(text)) return allowUrl ? text : undefined
      if (/^(?:data:|iVBORw0KGgo|\/9j\/|UklGR|R0lGOD|Qk)/i.test(text)) {
        return base64Image(text, inheritedMime)
      }
      return undefined
    }
    if (value instanceof ArrayBuffer) return fromBytes(new Uint8Array(value), inheritedMime)
    if (value instanceof Uint8Array) return fromBytes(value, inheritedMime)
    const record = asObj(value)
    if (!record || record['ok'] === false || record['truncated'] === true) return undefined
    const declaredMime = field([record], 'contentType', 'content_type', 'mimeType', 'mime_type', 'media_type')
    const mime = imageMime(declaredMime) ?? inheritedMime
    const dataUrl = field([record], 'dataUrl', 'data_url')
    const data = field([record], 'dataBase64', 'data_base64', 'imageBase64', 'image_base64', 'base64', 'png_base64', 'jpeg_base64', 'data')
    const format = mime ?? (record['jpeg_base64'] && data === record['jpeg_base64'] ? 'image/jpeg' : undefined)
    if (dataUrl && /^data:image\//i.test(dataUrl)) {
      const src = base64Image(dataUrl, mime)
      if (src) return src
    }
    if (data && (format || !declaredMime || /^application\/octet-stream\b/i.test(declaredMime) || /^data:image\//i.test(data))) {
      const src = base64Image(data, format)
      if (src) return src
    }
    const containers = nested ? [...PREVIEW_KEYS, 'result', 'data', 'body', 'image', 'source'] : ['image', 'source']
    for (const key of containers) {
      const src = read(record[key], depth + 1, mime)
      if (src) return src
    }
    const url = field([record], 'imageUrl', 'image_url', 'screenshotUrl', 'screenshot_url', 'previewUrl', 'preview_url') ??
      field([record], 'url', 'src', 'dataUrl', 'data_url')
    if (url && /^data:image\//i.test(url)) return base64Image(url, mime)
    return allowUrl ? httpUrl(url) : undefined
  }
  return read(raw, 0)
}

export function parseComputerContext(raw: unknown, sessionId?: string): ComputerContextSnap {
  const root = asObj(raw) ?? {}
  const records: Array<Record<string, unknown>> = []
  const active: Array<Record<string, unknown>> = []
  const latest: Array<Record<string, unknown>> = []
  const collect = (value: unknown, depth: number) => {
    if (depth > 8) return
    const record = asObj(value)
    if (!record || record['ok'] === false) return
    records.push(record)
    for (const key of ACTIVE_TASK_KEYS) {
      const task = asObj(record[key])
      if (task) active.push(task)
    }
    for (const key of LATEST_TASK_KEYS) {
      const task = asObj(record[key])
      if (task) latest.push(task)
    }
    if (Array.isArray(record['tasks'])) {
      for (const task of record['tasks']) {
        const item = asObj(task)
        if (item) latest.push(item)
      }
    }
    for (const key of ['result', 'context', 'data', 'computer', 'browser', 'live_view']) collect(record[key], depth + 1)
  }
  collect(root, 0)
  const ownerSession = (record: Record<string, unknown>) =>
    field([record, asObj(record['chat_context']) ?? {}], ...SESSION_KEYS)
  const sameSession = (record: Record<string, unknown>) => !sessionId || !ownerSession(record) || ownerSession(record) === sessionId
  const candidates = [...active, ...latest]
  const task = (sessionId ? candidates.find((item) => ownerSession(item) === sessionId) : undefined) ?? candidates.find(sameSession)
  const contextSessionId = records.map(ownerSession).find(Boolean)
  if (sessionId && contextSessionId && sessionId !== contextSessionId && (!task || !ownerSession(task))) {
    return { raw: {} }
  }

  const nestedRecords = records.reverse().filter(sameSession)
  const contextTaskId = field(nestedRecords, ...TASK_ID_KEYS)
  const taskId = (task && field([task], ...TASK_ID_KEYS, 'id')) ?? contextTaskId
  const sameTask = (record: Record<string, unknown>) => {
    const owner = field([record], ...TASK_ID_KEYS)
    return !taskId || !owner || owner === taskId
  }
  // Account-level summaries can describe a different task from the selected session.
  const competingTask = sessionId && candidates.some((item) => ownerSession(item) && !sameSession(item))
  const useContext = contextTaskId ? contextTaskId === taskId : !competingTask || contextSessionId === sessionId
  const details = [...(task ? [task] : []), ...(useContext ? nestedRecords.filter(sameTask) : [])]
  const previewEntries = details.flatMap((record) => PREVIEW_KEYS.map((key) => ({ key, value: record[key] })))
    .filter(({ value }) => {
      const preview = asObj(value)
      return preview ? sameTask(preview) && sameSession(preview) : typeof value === 'string'
    })
  const previewValues = previewEntries.map(({ value }) => value)
  const previews = previewValues.map(asObj).filter((value) => value !== undefined)
  const inlineSrc = previewValues.map((value) => parseComputerPreview(value, { allowUrl: false })).find(Boolean) ??
    details.map((record) => parseComputerPreview(record, { allowUrl: false, nested: false })).find(Boolean)
  const previewUrl = field(previews, 'url')
  const imageUrl = field([...previews, ...details], 'imageUrl', 'image_url', 'screenshotUrl', 'screenshot_url', 'previewUrl', 'preview_url') ??
    field(previewEntries.filter(({ key }) => /screenshot/i.test(key)).map(({ value }) => asObj(value) ?? {}), 'url', 'src') ??
    previewValues.find((value): value is string => typeof value === 'string' && Boolean(httpUrl(value))) ??
    (/\.(?:png|jpe?g|webp|gif|avif|bmp)(?:[?#]|$)/i.test(previewUrl ?? '') ? previewUrl : undefined)
  const previewPath = /\/computer\/previews\/([^/?#]+)\/([^/?#]+)/.exec(imageUrl ?? previewUrl ?? '')
  const pageUrl = field([...details, ...previews], 'current_url', 'currentUrl', 'page_url', 'pageUrl') ??
    field(details, 'url') ?? (previewPath || previewUrl === imageUrl ? undefined : previewUrl)
  if (!task && candidates.length && !contextTaskId && !inlineSrc && !imageUrl && !field(previews, ...TASK_ID_KEYS)) return { raw: {} }
  return {
    taskId: taskId ?? field(previews, ...TASK_ID_KEYS) ?? previewPath?.[1] ??
      (field(details, ...HASH_KEYS) || previews.length ? field(details, 'id') : undefined),
    sha256: field([...previews, ...details], ...HASH_KEYS) ?? (previewPath && (!taskId || taskId === previewPath[1]) ? previewPath[2] : undefined),
    sessionId: (task && ownerSession(task)) ?? [...previews, ...details].map(ownerSession).find(Boolean),
    status: field([...details, ...previews], 'status', 'state'),
    url: httpUrl(pageUrl),
    interactionUrl: httpUrl(field([...details, ...previews], 'interactive_url', 'interaction_url', 'viewer_url', 'view_url', 'live_view_url')),
    title: field([...details, ...previews], 'title', 'page_title', 'pageTitle'),
    inlineSrc: inlineSrc ?? (previewPath ? undefined : httpUrl(imageUrl) ?? (previewUrl !== pageUrl ? httpUrl(previewUrl) : undefined)),
    raw: task ?? nestedRecords[0] ?? {}
  }
}

export function isComputerTaskRunning(status?: string): boolean {
  return /^(?:running|pending|queued|starting|working|active|in[ _-]progress)$/i.test(status ?? '')
}

export function hasComputerContext(snapshot: ComputerContextSnap): boolean {
  return Boolean(snapshot.taskId || snapshot.sha256 || snapshot.url || snapshot.inlineSrc)
}

export function readComputerContext(rpc: MuseBridge['rpc'], accountId: string, sessionId?: string): Promise<ComputerContextSnap> {
  const key = JSON.stringify([accountId, sessionId])
  const inFlight = pendingContexts.get(key)
  if (inFlight) return inFlight
  const request = rpc({ accountId, method: 'computer.context', params: sessionId ? { session_id: sessionId } : {} })
    .then((raw) => parseComputerContext(raw, sessionId)).finally(() => pendingContexts.delete(key))
  pendingContexts.set(key, request)
  return request
}

const pendingContexts = new Map<string, Promise<ComputerContextSnap>>()

type PreviewRef = Pick<ComputerContextSnap, 'taskId' | 'sha256'>

export function matchesComputerPreview(snapshot: ComputerContextSnap, ref: PreviewRef): boolean {
  if (ref.taskId) return snapshot.taskId === ref.taskId
  if (ref.sha256) return snapshot.sha256 === ref.sha256
  return true
}

export function computerPreviewRef(snapshot: ComputerContextSnap | undefined, stored: PreviewRef & { inlineSrc?: string }) {
  const currentHash = snapshot?.sha256
  return {
    taskId: snapshot?.taskId ?? stored.taskId,
    sha256: currentHash ?? stored.sha256,
    inlineSrc: snapshot?.inlineSrc ?? (!currentHash || currentHash === stored.sha256 ? stored.inlineSrc : undefined)
  }
}

type PreviewBridge = Pick<MuseBridge, 'rpc' | 'previewWorkspaceFile'>

export function loadComputerPreview(
  muse: PreviewBridge, accountId: string, ref: PreviewRef & { inlineSrc?: string }
): Promise<string | undefined> {
  if (ref.inlineSrc && !httpUrl(ref.inlineSrc)) return Promise.resolve(parseComputerPreview(ref.inlineSrc, { allowUrl: false }))
  const key = JSON.stringify([accountId, ref.taskId, ref.sha256, ref.inlineSrc])
  const inFlight = pendingPreviews.get(key)
  if (inFlight) return inFlight
  const request = fetchComputerPreview(muse, accountId, ref).finally(() => pendingPreviews.delete(key))
  pendingPreviews.set(key, request)
  return request
}

const pendingPreviews = new Map<string, Promise<string | undefined>>()

async function fetchComputerPreview(
  muse: PreviewBridge, accountId: string, ref: PreviewRef & { inlineSrc?: string }
): Promise<string | undefined> {
  const readUrl = async (url: string) => parseComputerPreview(await muse.previewWorkspaceFile(accountId, url), { allowUrl: false })
  if (ref.inlineSrc) {
    try {
      const src = await readUrl(ref.inlineSrc)
      if (src || !ref.taskId || !ref.sha256) return src
    } catch (error) {
      if (!ref.taskId || !ref.sha256) throw error
    }
  }
  if (!ref.taskId || !ref.sha256) return undefined
  const raw = await muse.rpc({ accountId, method: 'computer.preview', params: { task_id: ref.taskId, sha256: ref.sha256 } })
  const src = raw instanceof Blob ? parseComputerPreview({ data: await raw.arrayBuffer(), contentType: raw.type }) : parseComputerPreview(raw)
  return src && httpUrl(src) ? readUrl(src) : src
}
