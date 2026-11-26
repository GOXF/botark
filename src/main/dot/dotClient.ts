import { randomUUID } from 'node:crypto'
import { setTimeout as delayDotRequest } from 'node:timers/promises'
import WebSocket from 'ws'
import { resolveDotTarget, type DotTarget } from '@shared/dotTarget'
import type { MuseRichWidgetView, MuseToolCallView } from '@shared/ipc'
import { asObj } from '@shared/parse'
import { inferMediaMime } from '../mediaMime'
import { proxyFetch, proxyWsAgent } from '../proxyTransport'
import {
  advanceDotTargetGeneration,
  DOT_ORIGIN,
  DotApiError,
  dotAppServerProtocols,
  dotClientHeaders,
  dotFileHeaders,
  dotSessionHeaders,
  dotSocketHeaders,
  ensureValidDotAccount,
  getDotCredentialRevision,
  getDotTargetGeneration,
  getStoredDotAccount,
  isEphemeralRoomTurnBotId,
  patchStoredDotAccount,
  refreshDotAccessToken,
  requireCredentialRevision,
  requireTargetGeneration,
  resolveDotProxyUrl,
  setDotAccountLifecycle,
  waitForDotRequest,
  type DotStoredAccount
} from './dotAuth'
import {
  dotApiErrorDetail,
  dotSnapshotGoal,
  findDotLibraryFile,
  findDotRoomAttachment,
  formatDotMemorySnapshot,
  isDotAckMessage,
  messageSignature,
  normalizeCalpicoRoomEvent,
  normalizeDotDownloadedFile,
  normalizeDotNativeTool,
  normalizeDotProfile,
  normalizeDotProfiles,
  normalizeDotThreadBusy,
  normalizeRoomHistory,
  normalizeRoomMessage,
  parseCelsiusMessage,
  parseDotJson,
  parseDotJsonObject,
  parseDotSseLine,
  type DotMemorySnapshotResult,
  type DotProfile,
  type DotRoomMessage
} from './dotNormalizers'

export {
  clearAllStoredDotAccounts,
  clearStoredDotAccount,
  decodeChatGptJwt,
  DOT_CODEX_CLIENT_ID,
  DOT_OAUTH_TOKEN_URL,
  DOT_ORIGIN,
  DotApiError,
  ensureValidDotAccount,
  getDotAuthStatus,
  getDotCredentialRevision,
  getDotTargetGeneration,
  getStoredDotAccount,
  importDotCredentialsFromRaw,
  isEphemeralRoomTurnBotId,
  listStoredDotAccounts,
  patchStoredDotAccount,
  refreshDotAccessToken,
  trySyncFromElectronPartition,
  upsertDotCredentials
} from './dotAuth'
export type { DecodedChatGptJwt, DotStoredAccount } from './dotAuth'
export { dotAttachmentsToMedia, inferDotFileMimeType, isDotAckMessage, normalizeRoomMessage } from './dotNormalizers'
export type { DotMemorySnapshotResult, DotProfile, DotRoomAttachment, DotRoomMessage } from './dotNormalizers'

export const DOT_API_BASE = 'https://chatgpt.com/backend-api'
export const DOT_APP_SERVER_WS_URL = 'wss://codex-cloud-backend.chatgpt.com/'

export type DotRealtimeCallback = (
  event:
    | {
        type: 'message'
        accountId: string
        botId?: string
        target: DotRoomTarget
        turnId?: string
        message: DotRoomMessage
        done: boolean
      }
    | {
        type: 'activity'
        accountId: string
        botId?: string
        target: DotRoomTarget
        turnId?: string
        code: string
        text?: string
        busy: boolean
      }
) => void

const realtimeListeners = new Set<DotRealtimeCallback>()

export function onDotRealtimeEvent(cb: DotRealtimeCallback): () => void {
  realtimeListeners.add(cb)
  return () => realtimeListeners.delete(cb)
}

function emitRealtime(event: Parameters<DotRealtimeCallback>[0]): void {
  for (const cb of realtimeListeners) {
    try {
      cb(event)
    } catch (err) {
      console.error('[dot] realtime listener failed', err)
    }
  }
}

export interface DotApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  path: string
  query?: Record<string, string | undefined>
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

export async function callDotApi<T = unknown>(
  accountId: string,
  opts: DotApiRequestOptions
): Promise<T> {
  const { signal } = opts
  const revision = getDotCredentialRevision(accountId)
  let acc = await ensureValidDotAccount(accountId, signal)
  signal?.throwIfAborted()
  requireCredentialRevision(accountId, revision)
  if (!acc.deviceId) {
    acc = patchStoredDotAccount(accountId, { deviceId: randomUUID() }) ?? acc
  }
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET')
  const relPath = opts.path.startsWith('/') ? opts.path : `/${opts.path}`
  const url = new URL(`${DOT_API_BASE}${relPath}`)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v)
    }
  }

  const doFetch = async (cred: DotStoredAccount): Promise<Response> => {
    const headers = dotClientHeaders(cred, opts.headers)
    let bodyPayload: string | undefined
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      bodyPayload = JSON.stringify(opts.body)
    }
    const effectiveProxy = await waitForDotRequest(resolveDotProxyUrl(accountId), signal)
    signal?.throwIfAborted()
    requireCredentialRevision(accountId, revision)
    const deadline = AbortSignal.timeout(30_000)
    return proxyFetch(effectiveProxy, url.toString(), {
      method,
      headers,
      body: bodyPayload,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline
    })
  }

  const maxAttempts = method === 'GET' ? 3 : 2
  let res: Response | undefined
  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await delayDotRequest(400 * attempt, undefined, { signal })
    }
    try {
      res = await doFetch(acc)
      if (res.status === 401 && acc.refreshToken) {
        void res.body?.cancel().catch(() => undefined)
        signal?.throwIfAborted()
        requireCredentialRevision(accountId, revision)
        const current = getStoredDotAccount(accountId)
        acc = current && current.accessToken !== acc.accessToken
          ? current
          : await waitForDotRequest(refreshDotAccessToken(accountId), signal)
        res = await doFetch(acc)
      }
      if (
        (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) &&
        attempt + 1 < maxAttempts
      ) {
        void res.body?.cancel().catch(() => undefined)
        continue
      }
      break
    } catch (err) {
      lastErr = err
      if (signal?.aborted || revision !== getDotCredentialRevision(accountId) || attempt + 1 >= maxAttempts) throw err
    }
  }
  if (!res) {
    throw lastErr instanceof Error ? lastErr : new DotApiError(0, 'Dot API network error')
  }

  const text = await res.text()
  signal?.throwIfAborted()
  requireCredentialRevision(accountId, revision)
  const json = text ? parseDotJson(text) : undefined
  const parsed = json === undefined ? text : json

  if (!res.ok) {
    const detail = dotApiErrorDetail(parsed, res.status)
    throw new DotApiError(res.status, `Dot API ${method} ${relPath} failed (${res.status}): ${detail}`, parsed)
  }

  return parsed as T
}

export async function listDots(
  accountId: string,
  signal?: AbortSignal
): Promise<{ items: DotProfile[]; activeDot?: DotProfile }> {
  let res: unknown
  try {
    res = await callDotApi(accountId, {
      method: 'GET',
      path: '/tbo',
      query: { limit: '25' },
      signal
    })
  } catch (err) {
    if (err instanceof DotApiError && (err.status === 404 || err.status === 403)) {
      throw new DotApiError(
        err.status,
        '该账号当前套餐未开通 Dot (/backend-api/tbo 404)，请选用 promax / pro / team 账号'
      )
    }
    throw err
  }

  const items = normalizeDotProfiles(res)

  const acc = getStoredDotAccount(accountId)
  const activeDot =
    (acc?.activeDotId ? items.find((d) => d.id === acc.activeDotId) : undefined) ??
    items.find((d) => d.isPrimary) ??
    items[0]

  return { items, activeDot }
}

function activateDotProfile(accountId: string, profile: DotProfile, botId?: string): DotRoomTarget {
  if (!profile.id || !profile.messagingRoomId) throw new DotApiError(404, 'No active Dot room found')
  patchStoredDotAccount(accountId, {
    activeDotId: profile.id,
    roomId: profile.messagingRoomId,
    threadId: profile.activeRootThreadId,
    ...(botId ? { botId } : {})
  })
  void ensureCelsiusWatcher(accountId, profile.messagingRoomId)
  return {
    dotId: profile.id,
    roomId: profile.messagingRoomId,
    threadId: profile.activeRootThreadId,
    generation: getDotTargetGeneration(accountId)
  }
}

export async function initializeDots(accountId: string, signal?: AbortSignal) {
  requireStableDotProfile(accountId)
  const generation = getDotTargetGeneration(accountId)
  const revision = getDotCredentialRevision(accountId)
  const listed = await listDots(accountId, signal)
  signal?.throwIfAborted()
  requireCredentialRevision(accountId, revision)
  requireTargetGeneration(accountId, generation)
  const activeDot = listed.activeDot ?? await createDot(accountId, { hasExisting: false, signal })
  signal?.throwIfAborted()
  requireCredentialRevision(accountId, revision)
  requireTargetGeneration(accountId, generation)
  const target = activateDotProfile(accountId, activeDot)
  return { items: listed.activeDot ? listed.items : [activeDot], activeDot, target }
}

export async function createDot(
  accountId: string,
  opts?: { displayName?: string; color?: string; hasExisting?: boolean; signal?: AbortSignal }
): Promise<DotProfile> {
  const generation = getDotTargetGeneration(accountId)
  const revision = getDotCredentialRevision(accountId)
  const existing =
    opts?.hasExisting !== undefined
      ? opts.hasExisting
      : (
          await callDotApi<{ items?: unknown[] }>(accountId, {
            method: 'GET',
            path: '/tbo',
            query: { limit: '5' },
            signal: opts?.signal
          }).catch(() => ({ items: [] }))
        ).items?.length
        ? true
        : false

  requireTargetGeneration(accountId, generation)
  requireCredentialRevision(accountId, revision)
  const raw = await callDotApi<Record<string, unknown>>(accountId, {
    method: 'POST',
    path: '/tbo',
    signal: opts?.signal,
    body: {
      display_name: opts?.displayName?.trim() || 'Dot',
      ...(opts?.color ? { color: opts.color } : {}),
      create_thread: true,
      create_additional: Boolean(existing),
      should_initialize: true
    }
  })

  return normalizeDotProfile(raw)
}

export async function getDot(accountId: string, dotId: string, signal?: AbortSignal): Promise<DotProfile> {
  const raw = await callDotApi<Record<string, unknown>>(accountId, {
    method: 'GET',
    path: `/tbo/${encodeURIComponent(dotId)}`,
    signal
  })
  return normalizeDotProfile(raw)
}

export async function deleteDot(accountId: string, dotId: string): Promise<unknown> {
  const result = await callDotApi(accountId, {
    method: 'DELETE',
    path: `/tbo/${encodeURIComponent(dotId)}`
  })
  if (getStoredDotAccount(accountId)?.activeDotId === dotId) {
    patchStoredDotAccount(accountId, { activeDotId: undefined, roomId: undefined, threadId: undefined })
  }
  return result
}

interface DotRoomTarget extends DotTarget {
  roomId: string
  threadId?: string
  generation: number
}

interface DotTurn {
  id: string
  botId?: string
  target?: DotRoomTarget
  controller: AbortController
  interruptNative?: () => void
}

const profileSelections = new Map<string, AbortController>()
const activeDotTurns = new Map<string, DotTurn>()
const runtimeInterrupts = new Map<string, { promise: Promise<void>; controller: AbortController }>()
const nativeConnections = new Map<string, Set<(error: Error) => void>>()

function requireStableDotProfile(accountId: string): void {
  if (profileSelections.has(accountId)) throw new DotApiError(409, 'A Dot profile switch is in progress')
}

export async function selectDotProfile(accountId: string, dotId: string, botId?: string) {
  profileSelections.get(accountId)?.abort()
  const selection = new AbortController()
  profileSelections.set(accountId, selection)
  const { signal } = selection
  const generation = invalidateDotTarget(accountId)
  const revision = getDotCredentialRevision(accountId)
  try {
    const dot = await getDot(accountId, dotId, signal)
    requireTargetGeneration(accountId, generation)
    requireCredentialRevision(accountId, revision)
    if (dot.id !== dotId) throw new DotApiError(409, 'The Dot profile ID changed')
    if (!dot.messagingRoomId) throw new DotApiError(404, 'No active Dot room found')
    const history = await fetchRoomHistory(accountId, {
      dotId, roomId: dot.messagingRoomId, threadId: dot.activeRootThreadId, generation
    }, { signal })
    requireTargetGeneration(accountId, generation)
    requireCredentialRevision(accountId, revision)
    profileSelections.delete(accountId)
    const target = activateDotProfile(accountId, dot, botId)
    ensureRoomPoller(accountId, dot.messagingRoomId, history.messages)
    return { ...history, ...target, dot }
  } finally {
    if (profileSelections.get(accountId) === selection) {
      profileSelections.delete(accountId)
      void ensureCelsiusWatcher(accountId, getStoredDotAccount(accountId)?.roomId)
    }
  }
}

function beginDotTurn(accountId: string, id: string = randomUUID(), botId?: string): DotTurn {
  abortDotTurn(accountId)
  const turn = { id, botId, controller: new AbortController() }
  activeDotTurns.set(accountId, turn)
  return turn
}

function abortDotTurn(accountId: string, turnId?: string): DotTurn | undefined {
  const turn = activeDotTurns.get(accountId)
  if (!turn || (turnId && turn.id !== turnId)) return
  activeDotTurns.delete(accountId)
  try {
    turn.interruptNative?.()
  } catch {
    /* The socket can close before the interrupt is sent. */
  }
  turn.controller.abort(new DotApiError(499, 'Dot turn cancelled'))
  return turn
}

function invalidateDotTarget(accountId: string): number {
  const generation = advanceDotTargetGeneration(accountId)
  abortDotTurn(accountId)
  closeCelsiusWatcher(accountId)
  return generation
}

export function disconnectDotAccount(accountId: string): void {
  profileSelections.get(accountId)?.abort()
  profileSelections.delete(accountId)
  invalidateDotTarget(accountId)
  runtimeInterrupts.get(accountId)?.controller.abort()
  for (const close of nativeConnections.get(accountId) ?? []) close(new DotApiError(499, 'Dot disconnected'))
}

setDotAccountLifecycle({
  closeTransport: disconnectDotAccount,
  targetChanged: (accountId) => {
    if (activeDotTurns.get(accountId)?.target) abortDotTurn(accountId)
    closeCelsiusWatcher(accountId)
  }
})

export async function pauseDotRuntime(accountId: string, dotId?: string): Promise<unknown> {
  const acc = getStoredDotAccount(accountId)
  const targetDotId = dotId || acc?.activeDotId
  const turn = activeDotTurns.get(accountId)
  if (!turn?.target || !targetDotId || turn.target.dotId === targetDotId) abortDotTurn(accountId)
  if (!targetDotId) return { ok: true }
  return callDotApi(accountId, {
    method: 'POST',
    path: `/tbo/${encodeURIComponent(targetDotId)}/runtime/pause`,
    body: {}
  })
}

export async function resumeDotRuntime(accountId: string, dotId?: string): Promise<unknown> {
  const acc = getStoredDotAccount(accountId)
  const targetDotId = dotId || acc?.activeDotId
  if (!targetDotId) throw new DotApiError(400, 'dotId required')
  return callDotApi(accountId, {
    method: 'POST',
    path: `/tbo/${encodeURIComponent(targetDotId)}/runtime/resume`,
    body: {}
  })
}

export async function cancelDotTurn(accountId: string, dotId?: string, turnId?: string): Promise<unknown> {
  const turn = abortDotTurn(accountId, turnId)
  const targetDotId = turn ? turn.target?.dotId : turnId ? undefined : dotId || getStoredDotAccount(accountId)?.activeDotId
  if (!targetDotId) return { ok: true }

  const previous = runtimeInterrupts.get(accountId)
  if (previous) {
    await previous.promise
    return { ok: true }
  }

  const revision = getDotCredentialRevision(accountId)
  const controller = new AbortController()
  const { signal } = controller
  const promise = (async () => {
    try {
      await callDotApi(accountId, {
        method: 'POST',
        path: `/tbo/${encodeURIComponent(targetDotId)}/runtime/pause`,
        body: {},
        signal
      })
      await delayDotRequest(600, undefined, { signal })
      requireCredentialRevision(accountId, revision)
      await callDotApi(accountId, {
        method: 'POST',
        path: `/tbo/${encodeURIComponent(targetDotId)}/runtime/resume`,
        body: {},
        signal
      })
    } catch {
      /* A failed interrupt should not block the next turn. */
    }
  })()
  runtimeInterrupts.set(accountId, { promise, controller })
  try {
    await promise
  } finally {
    if (runtimeInterrupts.get(accountId)?.promise === promise) runtimeInterrupts.delete(accountId)
  }
  return { ok: true }
}

export async function listDotThreads(accountId: string, dotId?: string): Promise<unknown> {
  requireStableDotProfile(accountId)
  const generation = getDotTargetGeneration(accountId)
  const acc = getStoredDotAccount(accountId)
  const targetDotId = dotId || acc?.activeDotId || (await listDots(accountId)).activeDot?.id
  if (!targetDotId) return { items: [] }
  requireTargetGeneration(accountId, generation)
  const result = await callDotApi(accountId, {
    method: 'GET',
    path: `/tbo/${encodeURIComponent(targetDotId)}/threads`
  })
  requireTargetGeneration(accountId, generation)
  return result
}

async function pinDotRoom(accountId: string, requested: DotTarget, signal?: AbortSignal): Promise<DotRoomTarget> {
  requireStableDotProfile(accountId)
  const generation = getDotTargetGeneration(accountId)
  const acc = getStoredDotAccount(accountId)
  const target = resolveDotTarget(requested, acc)
  if (target.roomId && target.dotId === acc?.activeDotId) {
    return { ...target, roomId: target.roomId, threadId: acc?.threadId, generation }
  }
  if (!target.dotId) return (await initializeDots(accountId, signal)).target
  const profile = await getDot(accountId, target.dotId, signal)
  signal?.throwIfAborted()
  requireTargetGeneration(accountId, generation)
  if (target.dotId !== profile.id) throw new DotApiError(409, 'The Dot profile ID changed')
  return activateDotProfile(accountId, profile)
}

interface RoomHistoryOptions {
  limit?: number
  after?: string
  signal?: AbortSignal
}

async function fetchRoomHistory(accountId: string, target: DotRoomTarget, opts?: RoomHistoryOptions) {
  const { roomId } = target
  requireTargetGeneration(accountId, target.generation)
  // IMPORTANT: Calpico room messages API enforces `limit <= 32` (HTTP 422 if > 32).
  const limit = Math.max(1, Math.min(32, opts?.limit ?? 32))
  const res = await callDotApi(accountId, {
    method: 'GET',
    path: `/messaging/rooms/${encodeURIComponent(roomId)}/messages`,
    query: {
      limit: String(limit),
      ...(opts?.after ? { after: opts.after } : {})
    },
    signal: opts?.signal
  })
  requireTargetGeneration(accountId, target.generation)
  return { ...target, ...normalizeRoomHistory(res, roomId) }
}

export async function listRoomMessages(accountId: string, opts?: DotTarget & RoomHistoryOptions) {
  const account = getStoredDotAccount(accountId)
  if (account?.mode === 'native' && !opts?.dotId && !opts?.roomId) {
    return { roomId: '', messages: [], hasMore: false }
  }
  const target = await pinDotRoom(accountId, opts ?? {}, opts?.signal)
  const history = await fetchRoomHistory(accountId, target, opts)
  requireTargetGeneration(accountId, target.generation)
  ensureRoomPoller(accountId, target.roomId, history.messages)
  return history
}

export async function downloadDotFile(
  accountId: string,
  opts: { url?: string; fileId?: string; roomId?: string; name?: string }
): Promise<{
  name: string
  filename: string
  mimeType: string
  size: number
  dataBase64: string
  text?: string
}> {
  const revision = getDotCredentialRevision(accountId)
  const acc = await ensureValidDotAccount(accountId)
  let targetUrl = opts.url?.trim() || ''
  let fileId = opts.fileId?.trim() || ''
  let fileName = opts.name?.trim() || ''

  if (targetUrl.startsWith('dotfile://')) {
    fileId = targetUrl.slice('dotfile://'.length)
    targetUrl = ''
  }

  const resolveFreshUrlFromRoom = async (): Promise<string> => {
    const listed = await listRoomMessages(accountId, {
      roomId: opts.roomId || acc.roomId,
      limit: 32
    }).catch(() => ({ messages: [] as DotRoomMessage[] }))
    const attachment = findDotRoomAttachment(listed.messages, fileId, fileName)
    if (!fileName && attachment?.name) fileName = attachment.name
    return attachment?.downloadUrl || ''
  }

  const resolveFreshUrlFromLibrary = async (fid: string): Promise<string> => {
    if (!fid.startsWith('file_') && !fid.startsWith('file-')) return ''
    try {
      const info = await callDotApi<{
        download_url?: string
        file_name?: string
      }>(accountId, {
        method: 'GET',
        path: `/files/download/${encodeURIComponent(fid)}`
      })
      if (!fileName && info?.file_name) fileName = info.file_name
      return info?.download_url || ''
    } catch {
      return ''
    }
  }

  if (!targetUrl && fileId) {
    if (fileId.startsWith('libfile_')) {
      try {
        const matched = findDotLibraryFile(await listDotLibraryNodes(accountId, 50), fileId)
        if (matched) {
          if (!fileName && matched.name) fileName = matched.name
          if (matched.downloadUrl) targetUrl = matched.downloadUrl
          else if (matched.fileId !== undefined) fileId = matched.fileId
        }
      } catch {
        /* ignore */
      }
    }
    if (!targetUrl && (fileId.startsWith('file_') || fileId.startsWith('file-'))) {
      targetUrl = await resolveFreshUrlFromLibrary(fileId)
    }
    if (!targetUrl) {
      targetUrl = await resolveFreshUrlFromRoom()
    }
  }

  if (!targetUrl && fileName) {
    targetUrl = await resolveFreshUrlFromRoom()
  }

  if (!targetUrl) {
    throw new DotApiError(404, '无法解析 Dot 文件下载链接')
  }

  const fetchUrl = async (rawUrl: string): Promise<Response> => {
    const expected = new URL(DOT_ORIGIN)
    const effectiveProxy = await resolveDotProxyUrl(accountId)
    const deadline = AbortSignal.timeout(30_000)
    let url = new URL(rawUrl, expected)
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (url.protocol !== 'https:' || url.username || url.password) {
        throw new DotApiError(400, 'Invalid Dot file URL')
      }
      requireCredentialRevision(accountId, revision)
      const current = getStoredDotAccount(accountId) ?? acc
      const headers = dotFileHeaders(current, url)
      const response = await proxyFetch(effectiveProxy, url.href, { headers, redirect: 'manual', signal: deadline })
      const location = response.headers.get('location')
      if (response.status < 300 || response.status >= 400 || !location) return response
      void response.body?.cancel().catch(() => undefined)
      url = new URL(location, url)
    }
    throw new DotApiError(502, 'Too many Dot file redirects')
  }

  let res = await fetchUrl(targetUrl)
  if (!res.ok && (res.status === 401 || res.status === 403 || res.status === 404)) {
    const refreshedUrl =
      (fileId && (fileId.startsWith('file_') || fileId.startsWith('file-'))
        ? await resolveFreshUrlFromLibrary(fileId)
        : '') || (await resolveFreshUrlFromRoom())
    if (refreshedUrl && refreshedUrl !== targetUrl) {
      targetUrl = refreshedUrl
      res = await fetchUrl(targetUrl)
    }
  }

  if (!res.ok) {
    throw new DotApiError(res.status, `下载 Dot 文件失败 (${res.status})`)
  }

  const ab = await res.arrayBuffer()
  requireCredentialRevision(accountId, revision)
  return normalizeDotDownloadedFile(Buffer.from(ab), fileName, res.headers.get('content-type') ?? undefined)
}

/**
 * Maintain a persistent `POST /backend-api/messaging/rooms/{room_id}/live` SSE connection
 * while the room is active so the backend streams `calpico-room-live` / `calpico-message-add`
 * events onto both the SSE response and the user's Celsius WebSocket.
 */
interface RoomLiveStreamState {
  ac: AbortController
  startedAt: number
}

const activeRoomLiveStreams = new Map<string, RoomLiveStreamState>()

export function closeRoomLiveStream(accountId: string, roomId?: string): void {
  for (const [k, v] of activeRoomLiveStreams.entries()) {
    if (k === `${accountId}:${roomId}` || (!roomId && k.startsWith(`${accountId}:`))) {
      v.ac.abort()
      activeRoomLiveStreams.delete(k)
    }
  }
}

export async function triggerRoomLivePush(accountId: string, roomId: string): Promise<void> {
  const acc = getStoredDotAccount(accountId)
  if (!roomId || acc?.roomId !== roomId) return
  const target = { dotId: acc.activeDotId, roomId, generation: getDotTargetGeneration(accountId) }
  const key = `${accountId}:${roomId}`
  const existing = activeRoomLiveStreams.get(key)
  if (existing && Date.now() - existing.startedAt < 10 * 60 * 1000) {
    return
  }
  existing?.ac.abort()

  const ac = new AbortController()
  activeRoomLiveStreams.set(key, { ac, startedAt: Date.now() })
  // Refresh after 10 minutes
  const maxTimer = setTimeout(() => {
    ac.abort()
    if (activeRoomLiveStreams.get(key)?.ac === ac) activeRoomLiveStreams.delete(key)
  }, 10 * 60 * 1000)

  try {
    const acc = await ensureValidDotAccount(accountId, ac.signal)
    const effectiveProxy = await resolveDotProxyUrl(accountId)
    ac.signal.throwIfAborted()
    requireTargetGeneration(accountId, target.generation)
    const res = await proxyFetch(effectiveProxy, `${DOT_API_BASE}/messaging/rooms/${encodeURIComponent(roomId)}/live`, {
      method: 'POST',
      headers: dotSessionHeaders(acc, 'text/event-stream'),
      redirect: 'error',
      signal: ac.signal
    })
    if (!res.ok || !res.body) return
    let buffer = ''
    const decoder = new TextDecoder()
    const processLines = (lines: string[]) => {
      for (const line of lines) {
        try {
          const event = parseDotSseLine(line)
          if (event) handleCalpicoEventPayload(accountId, event, target)
        } catch {
          /* ignore */
        }
      }
    }
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      ac.signal.throwIfAborted()
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      if (buffer.length > 1024 * 1024) return
      processLines(lines)
    }
    if (!ac.signal.aborted) processLines([buffer + decoder.decode()])
  } catch {
    /* stream closed or aborted */
  } finally {
    clearTimeout(maxTimer)
    if (activeRoomLiveStreams.get(key)?.ac === ac) {
      activeRoomLiveStreams.delete(key)
    }
  }
}

const NO_TOOLS_PROMPT_RE =
  /(do not (call|use) (or use )?any tools|without invoking any tools|いかなるツールも(呼び出したり使用したりしないで|使用しないで)|n'utilisez aucun outil|不要(调用|使用)任何工具)/i

export interface DotUploadAttachmentInput {
  name: string
  mimeType: string
  dataBase64: string
}

/**
 * Upload a user image / video / file to ChatGPT `/backend-api/files` so Dot can
 * inspect it inside a Calpico room message (`content.attachments`).
 */
export async function uploadDotRoomAttachment(
  accountId: string,
  file: DotUploadAttachmentInput,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const revision = getDotCredentialRevision(accountId)
  signal?.throwIfAborted()
  const bytes = Buffer.from(file.dataBase64, 'base64')
  const fileName = file.name || 'attachment'
  const mimeType = inferMediaMime({
    headerMime: file.mimeType,
    nameOrPath: fileName,
    bytes
  })
  const isImage = mimeType.startsWith('image/')
  const init = await callDotApi<{
    file_id?: string
    upload_url?: string
    status?: string
  }>(accountId, {
    method: 'POST',
    path: '/files',
    signal,
    body: {
      file_name: fileName,
      file_size: bytes.byteLength,
      use_case: isImage ? 'multimodal' : 'my_files',
      timezone_offset_min: new Date().getTimezoneOffset()
    }
  })

  const fileId = init?.file_id
  const uploadUrl = init?.upload_url
  if (!fileId || !uploadUrl) {
    throw new DotApiError(502, 'Dot 文件上传初始化失败（缺少 upload_url）')
  }

  const effectiveProxy = await resolveDotProxyUrl(accountId)
  signal?.throwIfAborted()
  requireCredentialRevision(accountId, revision)
  const deadline = AbortSignal.timeout(120_000)
  const isAzureBlob = /blob\.core\.windows\.net/i.test(uploadUrl)
  const putRes = await proxyFetch(effectiveProxy, uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType,
      ...(isAzureBlob ? { 'x-ms-blob-type': 'BlockBlob' } : {})
    },
    body: new Uint8Array(bytes),
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline
  })
  if (!putRes.ok) {
    throw new DotApiError(putRes.status, `Dot 文件上传失败 (${putRes.status})`)
  }

  await callDotApi(accountId, {
    method: 'POST',
    path: `/files/${encodeURIComponent(fileId)}/uploaded`,
    body: {},
    signal
  }).catch(() => undefined)
  signal?.throwIfAborted()
  requireCredentialRevision(accountId, revision)

  return {
    attachment_id: randomUUID(),
    type: 'file',
    file_id: fileId,
    file: {
      id: fileId,
      name: fileName,
      mime_type: mimeType,
      size: bytes.byteLength
    }
  }
}

async function sendRoomMessage(
  accountId: string,
  target: DotRoomTarget,
  opts: { text: string; attachments?: DotUploadAttachmentInput[]; signal: AbortSignal }
): Promise<{ roomId: string; dotId?: string; message: DotRoomMessage }> {
  const { roomId, dotId, generation } = target
  opts.signal.throwIfAborted()
  requireTargetGeneration(accountId, generation)

  const uploadedAttachments: Record<string, unknown>[] = []
  if (opts.attachments && opts.attachments.length > 0) {
    for (const att of opts.attachments) {
      if (!att.dataBase64) continue
      uploadedAttachments.push(await uploadDotRoomAttachment(accountId, att, opts.signal))
    }
  }

  // In Calpico rooms (`aeon`), posting a reply into the user's chat room is itself an internal
  // messaging tool action. Prompts that strictly forbid *all* tools can cause the model to write
  // only to its internal thread stdout without posting the reply to the room.
  const wireText = NO_TOOLS_PROMPT_RE.test(opts.text)
    ? `${opts.text}\n\n(Note for room delivery: do not use any external/search/code/file tools, but do send your final response text directly into this chat room.)`
    : opts.text

  requireTargetGeneration(accountId, generation)
  const raw = await callDotApi<Record<string, unknown>>(accountId, {
    method: 'POST',
    path: `/messaging/rooms/${encodeURIComponent(roomId)}/messages`,
    signal: opts.signal,
    body: {
      content: {
        text: wireText,
        attachments: uploadedAttachments
      },
      request_id: randomUUID(),
      idempotency_token: randomUUID()
    }
  })
  requireTargetGeneration(accountId, generation)

  const message = normalizeRoomMessage(raw, roomId)
  message.text = opts.text
  return { roomId, dotId, message }
}

// ============================================================================
// Persistent Celsius WebSocket Watcher (`GET /backend-api/celsius/ws/user`)
// & Continuous Room Message Sync Poller
// ============================================================================

interface CelsiusWatcherState {
  controller: AbortController
  ws?: WebSocket
  reconnectTimer?: NodeJS.Timeout
  pingTimer?: NodeJS.Timeout
}

interface RoomPollerState {
  target: DotRoomTarget
  controller: AbortController
  request?: AbortController
  timer?: NodeJS.Timeout
  lastActiveAt: number
  busy: boolean
  seeded: boolean
  seenMessageIds: Map<string, string>
}

const celsiusWatchers = new Map<string, CelsiusWatcherState>()
const roomPollers = new Map<string, RoomPollerState>()
const MAX_SEEN_MESSAGE_IDS = 512

function rememberRoomMessage(poller: RoomPollerState | undefined, msg: DotRoomMessage): boolean {
  if (!poller) return true
  const signature = messageSignature(msg)
  if (poller.seenMessageIds.get(msg.id) === signature) return false
  poller.seenMessageIds.delete(msg.id)
  poller.seenMessageIds.set(msg.id, signature)
  if (poller.seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
    const oldest = poller.seenMessageIds.keys().next().value
    if (oldest !== undefined) poller.seenMessageIds.delete(oldest)
  }
  return true
}

export function bumpDotRoomActivity(accountId: string, roomId?: string, busy = true): void {
  const poller = roomPollers.get(accountId)
  if (!poller || (roomId && poller.target.roomId !== roomId)) return
  poller.lastActiveAt = Date.now()
  poller.busy = busy
}

function turnForRoom(accountId: string, target: DotRoomTarget): DotTurn | undefined {
  const turn = activeDotTurns.get(accountId)
  if (turn?.target?.generation === target.generation && turn.target.roomId === target.roomId) return turn
  return undefined
}

export function ensureRoomPoller(accountId: string, roomId: string, seedMessages?: DotRoomMessage[]): void {
  const acc = getStoredDotAccount(accountId)
  if (!acc || !roomId || acc.roomId !== roomId) return
  const target = { dotId: acc.activeDotId, roomId, generation: getDotTargetGeneration(accountId) }
  const existing = roomPollers.get(accountId)
  if (existing) {
    if (seedMessages) {
      for (const message of seedMessages) rememberRoomMessage(existing, message)
      existing.seeded = true
    }
    return
  }

  const poller: RoomPollerState = {
    target,
    controller: new AbortController(),
    lastActiveAt: Date.now(),
    busy: false,
    seeded: Boolean(seedMessages),
    seenMessageIds: new Map()
  }
  for (const message of seedMessages ?? []) rememberRoomMessage(poller, message)
  roomPollers.set(accountId, poller)

  const tick = async () => {
    if (poller.controller.signal.aborted) return
    if (!turnForRoom(accountId, target)) {
      const request = new AbortController()
      poller.request = request
      try {
        const { messages } = await fetchRoomHistory(accountId, target, { limit: 12, signal: request.signal })
        request.signal.throwIfAborted()
        for (const message of messages) {
          const fresh = rememberRoomMessage(poller, message)
          if (poller.seeded && fresh && message.role === 'bot' && (message.text || message.attachments?.length)) {
            poller.lastActiveAt = Date.now()
            emitRealtime({
              type: 'message',
              accountId,
              botId: getStoredDotAccount(accountId)?.botId,
              target,
              message,
              done: true
            })
          }
        }
        poller.seeded = true
      } catch {
        /* Retry transient errors on the next interval. */
      } finally {
        poller.request = undefined
      }
    }
    if (!poller.controller.signal.aborted) {
      const recentlyActive = poller.busy || Date.now() - poller.lastActiveAt < 6 * 60 * 1000
      poller.timer = setTimeout(() => void tick(), recentlyActive ? 3000 : 12000)
    }
  }
  poller.timer = setTimeout(() => void tick(), 3500)
}

function handleCalpicoEventPayload(
  accountId: string,
  ev: Record<string, unknown>,
  target: DotRoomTarget
): void {
  if (getDotTargetGeneration(accountId) !== target.generation) return
  const acc = getStoredDotAccount(accountId)
  if (!acc || acc.roomId !== target.roomId || acc.activeDotId !== target.dotId) return
  const event = normalizeCalpicoRoomEvent(ev, target.roomId)
  if (!event) return

  const turn = turnForRoom(accountId, target)
  const route = {
    accountId,
    botId: turn?.botId ?? acc.botId,
    target,
    turnId: turn?.id
  }

  if (event.type === 'message') {
    const poller = roomPollers.get(accountId)
    if (poller && !rememberRoomMessage(poller, event.message)) return
    bumpDotRoomActivity(accountId, target.roomId, true)
    emitRealtime({ type: 'message', ...route, message: event.message, done: true })
  } else {
    bumpDotRoomActivity(accountId, target.roomId, event.busy)
    const { code, text, busy } = event
    emitRealtime({ type: 'activity', ...route, code, text, busy })
  }
}

export function closeCelsiusWatcher(accountId: string): void {
  if (accountId === '*') {
    const ids = new Set([
      ...celsiusWatchers.keys(),
      ...roomPollers.keys(),
      ...activeDotTurns.keys(),
      ...nativeConnections.keys(),
      ...runtimeInterrupts.keys(),
      ...profileSelections.keys()
    ])
    for (const id of ids) disconnectDotAccount(id)
    return
  }

  closeRoomLiveStream(accountId)
  const poller = roomPollers.get(accountId)
  if (poller) {
    roomPollers.delete(accountId)
    poller.controller.abort()
    poller.request?.abort()
    clearTimeout(poller.timer)
  }
  const watcher = celsiusWatchers.get(accountId)
  if (watcher) {
    celsiusWatchers.delete(accountId)
    watcher.controller.abort()
    clearTimeout(watcher.reconnectTimer)
    clearInterval(watcher.pingTimer)
    watcher.ws?.terminate()
  }
}

export function rebindDotAccountNetwork(accountId: string): void {
  const wasWatching = celsiusWatchers.has(accountId) || roomPollers.has(accountId)
  disconnectDotAccount(accountId)
  // The account proxy settings have taken over this account's routing.
  patchStoredDotAccount(accountId, { proxyUrl: undefined })
  if (wasWatching) void ensureCelsiusWatcher(accountId, getStoredDotAccount(accountId)?.roomId)
}

export async function ensureCelsiusWatcher(accountId: string, roomId?: string): Promise<void> {
  const acc = getStoredDotAccount(accountId)
  if (!acc || !roomId || acc.roomId !== roomId || profileSelections.has(accountId)) return
  ensureRoomPoller(accountId, roomId)
  void triggerRoomLivePush(accountId, roomId)
  if (celsiusWatchers.has(accountId)) return

  const target = { dotId: acc.activeDotId, roomId, generation: getDotTargetGeneration(accountId) }
  const watcher: CelsiusWatcherState = { controller: new AbortController() }
  celsiusWatchers.set(accountId, watcher)
  const { signal } = watcher.controller
  const ownsWatcher = () => !signal.aborted &&
    celsiusWatchers.get(accountId) === watcher && getDotTargetGeneration(accountId) === target.generation
  const reconnect = () => {
    if (!ownsWatcher()) return
    clearInterval(watcher.pingTimer)
    watcher.ws = undefined
    watcher.reconnectTimer = setTimeout(() => {
      if (!ownsWatcher()) return
      celsiusWatchers.delete(accountId)
      void ensureCelsiusWatcher(accountId, roomId)
    }, 4000)
  }
  try {
    const info = await callDotApi<{ websocket_url?: string }>(accountId, {
      method: 'GET',
      path: '/celsius/ws/user',
      signal
    })
    const proxy = await resolveDotProxyUrl(accountId)
    if (!ownsWatcher()) return
    if (!info?.websocket_url) {
      reconnect()
      return
    }
    const socketUrl = new URL(info.websocket_url)
    if (socketUrl.protocol !== 'wss:') throw new DotApiError(502, 'Invalid Celsius WebSocket URL')
    const ws = new WebSocket(socketUrl, {
      agent: proxyWsAgent(proxy),
      handshakeTimeout: 15_000,
      headers: dotSocketHeaders()
    })
    watcher.ws = ws
    ws.on('error', () => ws.terminate())
    ws.once('close', reconnect)
    ws.once('open', () => {
      if (!ownsWatcher()) return
      watcher.pingTimer = setInterval(() => {
        if (ownsWatcher() && ws.readyState === WebSocket.OPEN) ws.ping()
      }, 25_000)
      ws.send(JSON.stringify([
        { command: { type: 'connect', presence: { type: 'presence', state: 'foreground' } }, id: 1 },
        { command: { type: 'subscribe', topic_id: 'calpico-chatgpt-messaging' }, id: 2 },
        { command: { type: 'subscribe', topic_id: `calpico-room-live:${roomId}` }, id: 3 }
      ]))
    })
    ws.on('message', (data) => {
      if (!ownsWatcher()) return
      try {
        const event = parseCelsiusMessage(data.toString())
        if (event) handleCalpicoEventPayload(accountId, event, target)
      } catch {
        /* Ignore malformed frames. */
      }
    })
  } catch {
    reconnect()
  }
}

/**
 * Send a message to a Dot's Calpico room and watch both Celsius WS + room message polling
 * until Dot finishes its turn (including multi-minute code/file generation turns).
 */
export async function sendAndWatchDotRoomReply(
  accountId: string,
  opts: DotTarget & {
    turnId?: string
    botId?: string
    text: string
    attachments?: DotUploadAttachmentInput[]
    timeoutMs?: number
    onMessage?: (msg: DotRoomMessage, done: boolean, stillBusy?: boolean, target?: DotTarget) => void
    onActivity?: (code: string, text: string | undefined, busy: boolean) => void
    /** The user message is in the room (before any reply). */
    onSent?: () => void
  }
): Promise<{ roomId: string; sentMessage: DotRoomMessage; replies: DotRoomMessage[] }> {
  const turn = beginDotTurn(accountId, opts.turnId, opts.botId)
  const { signal } = turn.controller
  try {
    const target = await pinDotRoom(accountId, opts, signal)
    signal.throwIfAborted()
    requireTargetGeneration(accountId, target.generation)
    turn.target = target
    const poller = roomPollers.get(accountId)
    poller?.request?.abort()

    if (opts.botId && !isEphemeralRoomTurnBotId(opts.botId)) {
      patchStoredDotAccount(accountId, { botId: opts.botId })
    }
    void ensureCelsiusWatcher(accountId, target.roomId)
    const interrupt = runtimeInterrupts.get(accountId)
    if (interrupt) await waitForDotRequest(interrupt.promise, signal)
    const before = await fetchRoomHistory(accountId, target, { limit: 32, signal }).catch(() => undefined)
    signal.throwIfAborted()
    requireTargetGeneration(accountId, target.generation)
    const sent = await sendRoomMessage(accountId, target, { ...opts, signal })
    signal.throwIfAborted()
    opts.onSent?.()

    const { roomId } = target
    const beforeIds = new Set(before?.messages.map((m) => m.id))
    const sentId = sent.message.id
    const sentCreatedAtMs = sent.message.createdAtMs || Date.now()
    beforeIds.add(sentId)
    bumpDotRoomActivity(accountId, roomId, true)

    const startedAt = Date.now()
    const repliesById = new Map<string, DotRoomMessage>()
    const emittedSignatures = new Map<string, string>()
    let lastBusy = true
    let lastReplyAt = 0
    let idleEmptyChecks = 0
    let recoverySent = false
    let threadId = target.threadId

    opts.onActivity?.('thinking', 'Thinking…', true)

    return await new Promise((resolve, reject) => {
      let finished = false
      let pollTimer: NodeJS.Timeout | undefined
      const ownsTurn = () => !finished && !signal.aborted &&
        activeDotTurns.get(accountId) === turn && getDotTargetGeneration(accountId) === target.generation
      const finish = () => {
        if (finished) return
        finished = true
        clearTimeout(pollTimer)
        clearTimeout(deadline)
        signal.removeEventListener('abort', finish)
        unsub()
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        bumpDotRoomActivity(accountId, roomId, false)
        opts.onActivity?.('idle', undefined, false)
        resolve({ roomId, sentMessage: sent.message, replies: [...repliesById.values()] })
        turn.controller.abort()
      }

      const recordReply = (msg: DotRoomMessage) => {
        if (!ownsTurn() || msg.role !== 'bot' || (!msg.text && !msg.attachments?.length)) return
        if (beforeIds.has(msg.id) || msg.createdAtMs < sentCreatedAtMs - 5000) return
        const signature = messageSignature(msg)
        if (emittedSignatures.get(msg.id) === signature) return
        rememberRoomMessage(roomPollers.get(accountId), msg)
        repliesById.set(msg.id, msg)
        emittedSignatures.set(msg.id, signature)
        lastReplyAt = Date.now()
        idleEmptyChecks = 0
        if (opts.onMessage) {
          opts.onMessage(msg, true, isDotAckMessage(msg), target)
        } else {
          emitRealtime({
            type: 'message', accountId, botId: opts.botId ?? getStoredDotAccount(accountId)?.botId,
            target, message: msg, done: true
          })
        }
      }

      const recover = async (transplant: boolean) => {
        if (!ownsTurn() || recoverySent) return
        recoverySent = true
        idleEmptyChecks = 0
        lastBusy = true
        opts.onActivity?.(
          'thinking',
          transplant
            ? 'Dot 容器刚完成自动迁移，正在自动续发任务获取回复…'
            : 'Dot 已在内部完成计算，正在同步回复到聊天室…',
          true
        )
        try {
          const text = transplant
            ? `请继续直接完成刚才这条任务并把完整结果发到当前聊天室：\n\n${opts.text}`
            : '请把你刚才针对上一条消息生成的完整结果直接发送到当前聊天室中（不要只留在内部输出）。'
          const nudge = await sendRoomMessage(accountId, target, { text, signal })
          if (ownsTurn()) beforeIds.add(nudge.message.id)
        } catch {
          /* A failed recovery still allows any late reply to arrive. */
        }
      }

      const checkRootBusy = () => threadId ? isDotRootThreadBusy(accountId, threadId, signal) : Promise.resolve(null)
      const pollOnce = async () => {
        if (!ownsTurn()) return
        void triggerRoomLivePush(accountId, roomId)
        try {
          const listed = await fetchRoomHistory(accountId, target, { after: sentId, limit: 16, signal })
          if (!ownsTurn()) return
          for (const msg of listed.messages) recordReply(msg)
          const replies = [...repliesById.values()]
          const latest = replies.at(-1)
          if (latest && (!lastBusy || Date.now() - lastReplyAt > 2500)) {
            const transplant = latest.turnTrigger === 'aeon_transplant'
            if (transplant && target.dotId) {
              const profile = await getDot(accountId, target.dotId, signal)
              if (!ownsTurn()) return
              if (profile.messagingRoomId !== roomId) {
                finish()
                return
              }
              threadId = profile.activeRootThreadId
            }
            const rootBusy = await checkRootBusy()
            if (!ownsTurn()) return
            if (rootBusy || (isDotAckMessage(latest) && Date.now() - lastReplyAt < 8000)) {
              lastBusy = true
              opts.onActivity?.('thinking', 'Dot 正在后台处理并生成后续回复/文件…', true)
            } else if (!recoverySent && rootBusy === false && replies.every((m) => m.turnTrigger === 'aeon_transplant')) {
              await recover(true)
            } else {
              finish()
            }
          } else if (!latest && Date.now() - startedAt > 6000) {
            const rootBusy = await checkRootBusy()
            if (!ownsTurn()) return
            const quietFor = Date.now() - startedAt
            if (rootBusy === null) {
              if (quietFor > 60_000) idleEmptyChecks++
            } else if (!rootBusy && (!lastBusy || quietFor > 15_000)) {
              idleEmptyChecks++
            } else {
              idleEmptyChecks = 0
            }
            if (idleEmptyChecks >= 2) {
              if (!recoverySent && rootBusy === false) await recover(false)
              else if (idleEmptyChecks >= 4 || rootBusy === null) finish()
            }
          }
        } catch {
          /* Retry transient poll errors while the same turn is active. */
        }
        if (ownsTurn()) pollTimer = setTimeout(() => void pollOnce(), 1800)
      }

      const unsub = onDotRealtimeEvent((event) => {
        if (!ownsTurn() || event.accountId !== accountId || event.turnId !== turn.id) return
        if (event.type === 'activity') {
          lastBusy = event.busy
          opts.onActivity?.(event.code, event.text, event.busy)
        } else {
          recordReply(event.message)
        }
      })
      const deadline = setTimeout(finish, opts.timeoutMs ?? 300_000)
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted) finish()
      else pollTimer = setTimeout(() => void pollOnce(), 1400)
    })
  } finally {
    if (activeDotTurns.get(accountId) === turn) activeDotTurns.delete(accountId)
  }
}

// ============================================================================
// Codex Cloud App-Server WebSocket (`wss://codex-cloud-backend.chatgpt.com/`)
// ============================================================================

async function withAppServerWs<T>(
  accountId: string,
  fn: (helpers: {
    call: (method: string, params?: unknown) => Promise<unknown>
    ws: WebSocket
    account: DotStoredAccount
    signal: AbortSignal
  }) => Promise<T>,
  timeoutMs = 35_000,
  turnSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController()
  const signal = turnSignal ? AbortSignal.any([turnSignal, controller.signal]) : controller.signal
  const close = (error: Error) => controller.abort(error)
  const connections = nativeConnections.get(accountId) ?? new Set()
  connections.add(close)
  nativeConnections.set(accountId, connections)
  const timeout = setTimeout(() => close(new DotApiError(504, 'Dot App-Server WebSocket timed out')), timeoutMs)
  const revision = getDotCredentialRevision(accountId)
  try {
    const account = await ensureValidDotAccount(accountId, signal)
    const effectiveProxy = await waitForDotRequest(resolveDotProxyUrl(accountId), signal)
    signal.throwIfAborted()
    requireCredentialRevision(accountId, revision)
    return await new Promise<T>((resolve, reject) => {
      const ws = new WebSocket(
        DOT_APP_SERVER_WS_URL,
        dotAppServerProtocols(account),
        {
          agent: proxyWsAgent(effectiveProxy),
          headers: dotSocketHeaders()
        }
      )

      let nextId = 1
      let settled = false
      const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
      const cleanup = (error: unknown) => {
        settled = true
        signal.removeEventListener('abort', onAbort)
        ws.off('message', onResponse)
        ws.off('open', onOpen)
        ws.off('close', onClose)
        for (const request of pending.values()) request.reject(error)
        pending.clear()
        controller.abort(error)
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate()
        else ws.close()
      }
      const fail = (error: unknown) => {
        if (settled) return
        cleanup(error)
        reject(error)
      }
      const onAbort = () => fail(signal.reason)
      const onClose = () => fail(new DotApiError(502, 'App-Server WebSocket closed unexpectedly'))

      const call = (method: string, params: unknown = {}): Promise<unknown> =>
        new Promise((resolveCall, rejectCall) => {
          signal.throwIfAborted()
          const id = nextId++
          pending.set(id, { resolve: resolveCall, reject: rejectCall })
          try {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (error) => {
              if (error) fail(error)
            })
          } catch (error) {
            fail(error)
          }
        })

      const onResponse = (data: WebSocket.RawData) => {
        try {
          const msg = parseDotJsonObject(data.toString())
          if (!msg) return
          const id = msg['id']
          if (typeof id !== 'number') return
          const request = pending.get(id)
          if (!request) return
          pending.delete(id)
          const error = msg['error'] as { message?: string } | undefined
          if (error) request.reject(new DotApiError(400, error.message || 'JSON-RPC error', error))
          else request.resolve(msg['result'])
        } catch {
          /* Ignore malformed frames. */
        }
      }
      const onOpen = async () => {
        try {
          await call('initialize', {
            clientInfo: { name: 'chatgpt-web', title: 'ChatGPT Dot', version: '1.0.0' },
            capabilities: { experimentalApi: true }
          })
          signal.throwIfAborted()
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }))
          const out = await fn({ call, ws, account, signal })
          if (settled) return
          cleanup(new DotApiError(499, 'Dot App-Server request ended'))
          resolve(out)
        } catch (error) {
          fail(error)
        }
      }

      ws.on('error', fail)
      ws.once('close', () => ws.off('error', fail))
      ws.once('close', onClose)
      ws.on('message', onResponse)
      ws.once('open', onOpen)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  } finally {
    clearTimeout(timeout)
    connections.delete(close)
    if (connections.size === 0) nativeConnections.delete(accountId)
  }
}

export async function getDotRateLimits(accountId: string): Promise<unknown> {
  return withAppServerWs(accountId, ({ call }) => call('account/rateLimits/read', {}))
}

export async function listDotModels(accountId: string): Promise<unknown> {
  return withAppServerWs(accountId, ({ call }) =>
    call('model/list', { includeHidden: true, cursor: null, limit: 100 })
  )
}

export async function getDotThreadGoal(accountId: string, threadId?: string): Promise<unknown> {
  const acc = getStoredDotAccount(accountId)
  const tid = threadId || acc?.threadId
  if (!tid) return { goal: null }
  return withAppServerWs(accountId, ({ call }) =>
    call('thread/goal/get', { threadId: tid })
  ).catch(() => ({ goal: null }))
}

export async function setDotThreadGoal(
  accountId: string,
  goal: string,
  threadId?: string
): Promise<unknown> {
  const acc = getStoredDotAccount(accountId)
  const tid = threadId || acc?.threadId
  if (!tid) throw new DotApiError(400, 'threadId required')
  return withAppServerWs(accountId, ({ call }) =>
    call('thread/goal/set', { threadId: tid, goal })
  )
}

export async function clearDotThreadGoal(accountId: string, threadId?: string): Promise<unknown> {
  const acc = getStoredDotAccount(accountId)
  const tid = threadId || acc?.threadId
  if (!tid) throw new DotApiError(400, 'threadId required')
  return withAppServerWs(accountId, ({ call }) =>
    call('thread/goal/clear', { threadId: tid })
  )
}

/**
 * Stream a native turn directly on `wss://codex-cloud-backend.chatgpt.com/` using `gpt-6-astra`
 * (or any Sol/Luna/Terra model), emitting token-by-token deltas (`item/agentMessage/delta`) and
 * tool call status (`item/started` / `item/completed`).
 */
export async function streamDotNativeTurn(
  accountId: string,
  opts: {
    text: string
    turnId?: string
    threadId?: string
    signal?: AbortSignal
    model?: string
    effort?: string
    onSent?: () => void
    onDelta?: (args: {
      messageId: string
      text: string
      done: boolean
      tools?: MuseToolCallView[]
      richWidgets?: MuseRichWidgetView[]
    }) => void
    onActivity?: (code: string, text: string | undefined, busy: boolean) => void
  }
): Promise<{ messageId: string; text: string; threadId: string; tools: MuseToolCallView[] }> {
  requireStableDotProfile(accountId)
  opts.signal?.throwIfAborted()
  const turn = beginDotTurn(accountId, opts.turnId)
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, turn.controller.signal])
    : turn.controller.signal

  try {
    return await withAppServerWs(accountId, async ({ call, ws, account, signal }) => {
      const model = opts.model || account.model || 'gpt-6-astra'
      const effort = opts.effort || account.effort || 'medium'
      opts.onActivity?.('thinking', `Running ${model}…`, true)

      let threadId = ''
      const requestedThreadId = opts.threadId?.trim()
      if (requestedThreadId) {
        try {
          const resumed = (await call('thread/resume', {
            threadId: requestedThreadId,
            model,
            serviceTier: 'fast',
            approvalPolicy: 'never'
          })) as { thread?: { id?: string } } | undefined
          threadId = resumed?.thread?.id || requestedThreadId
        } catch {
          try {
            const readRes = (await call('thread/read', { threadId: requestedThreadId })) as
              | { thread?: { id?: string } }
              | undefined
            if (readRes?.thread?.id) {
              threadId = readRes.thread.id
            } else if (readRes) {
              threadId = requestedThreadId
            }
          } catch {
            /* fall back to thread/start */
          }
        }
      }
      if (!threadId) {
        const started = (await call('thread/start', {
          model,
          serviceTier: 'fast',
          approvalPolicy: 'never'
        })) as { thread?: { id?: string } }
        threadId = started?.thread?.id || randomUUID()
      }

      signal.throwIfAborted()
      let remoteTurnId: string | undefined
      const interrupt = () => {
        if (!remoteTurnId || ws.readyState !== WebSocket.OPEN) return
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 999,
          method: 'turn/interrupt',
          params: { threadId, turnId: remoteTurnId }
        }))
      }
      turn.interruptNative = interrupt
      let messageId = `dot_native_${randomUUID()}`
      let fullText = ''
      const toolsMap = new Map<string, MuseToolCallView>()
      let sentNotified = false
      const notifySent = () => {
        if (sentNotified) return
        sentNotified = true
        opts.onSent?.()
      }

      return new Promise<{
        messageId: string
        text: string
        threadId: string
        tools: MuseToolCallView[]
      }>((resolve, reject) => {
        let settled = false
        const cleanupSession = () => {
          ws.off('message', onMsg)
          signal.removeEventListener('abort', abortTurn)
          turn.interruptNative = undefined
        }
        const fail = (error: unknown) => {
          if (settled) return
          settled = true
          cleanupSession()
          reject(error)
        }
        const abortTurn = () => fail(signal.reason)

        const onMsg = (data: WebSocket.RawData) => {
          if (settled || signal.aborted || activeDotTurns.get(accountId) !== turn) return
          try {
            const frame = parseDotJsonObject(data.toString())
            const method = frame?.['method']
            if (!method) return
            const p = asObj(frame['params']) ?? {}
            const eventThreadId = p['threadId']
            const eventTurnId = p['turnId'] ?? (p['turn'] as { id?: unknown } | undefined)?.id
            if (typeof eventThreadId === 'string' && eventThreadId !== threadId) return
            if (remoteTurnId && typeof eventTurnId === 'string' && eventTurnId !== remoteTurnId) return

            if (method === 'turn/started') {
              notifySent()
              const turn = p['turn'] as { id?: string } | undefined
              if (turn?.id) remoteTurnId = turn.id
            } else if (method === 'item/started') {
              const item = p['item'] as Record<string, unknown> | undefined
              if (!item) return
              const itemType = String(item['type'] ?? '')
              const itemId = String(item['id'] ?? randomUUID())
              if (itemType === 'agentMessage') {
                messageId = `dot_${itemId}`
              } else if (itemType !== 'userMessage' && itemType !== 'reasoning') {
                toolsMap.set(itemId, normalizeDotNativeTool(item, itemId, itemType))
                opts.onActivity?.('tool', `Running ${itemType}…`, true)
                opts.onDelta?.({
                  messageId,
                  text: fullText,
                  done: false,
                  tools: [...toolsMap.values()]
                })
              }
            } else if (method === 'item/agentMessage/delta') {
              const delta = typeof p['delta'] === 'string' ? p['delta'] : ''
              if (delta) {
                fullText += delta
                opts.onDelta?.({
                  messageId,
                  text: fullText,
                  done: false,
                  ...(toolsMap.size > 0 ? { tools: [...toolsMap.values()] } : {})
                })
              }
            } else if (method === 'item/completed') {
              const item = p['item'] as Record<string, unknown> | undefined
              if (!item) return
              const itemType = String(item['type'] ?? '')
              const itemId = String(item['id'] ?? '')
              if (itemType === 'agentMessage') {
                const finalItemText = typeof item['text'] === 'string' ? item['text'] : ''
                if (finalItemText && finalItemText.length >= fullText.length) {
                  fullText = finalItemText
                }
              } else if (toolsMap.has(itemId)) {
                const prev = toolsMap.get(itemId)!
                toolsMap.set(itemId, { ...prev, status: 'completed' })
              }
            } else if (method === 'turn/completed') {
              if (settled) return
              settled = true
              cleanupSession()
              opts.onActivity?.('idle', undefined, false)
              opts.onDelta?.({
                messageId,
                text: fullText,
                done: true,
                ...(toolsMap.size > 0 ? { tools: [...toolsMap.values()] } : {})
              })
              resolve({
                messageId,
                text: fullText,
                threadId,
                tools: [...toolsMap.values()]
              })
            }
          } catch {
            /* ignore */
          }
        }

        ws.on('message', onMsg)
        signal.addEventListener('abort', abortTurn, { once: true })
        if (signal.aborted) {
          abortTurn()
          return
        }

        call('turn/start', {
          threadId,
          input: [{ type: 'text', text: opts.text }],
          model,
          effort,
          serviceTier: 'fast'
        })
          .then((response) => {
            if (settled || signal.aborted) return
            const result = response as { turn?: { id?: string } } | undefined
            remoteTurnId ??= result?.turn?.id
            notifySent()
          }, fail)
      })
    }, 120_000, signal)
  } finally {
    if (activeDotTurns.get(accountId) === turn) activeDotTurns.delete(accountId)
  }
}

// ============================================================================
// Library & Dynamic Pages (`/backend-api/files/library/nodes` & `/backend-api/pages`)
// ============================================================================

export async function listDotLibraryNodes(accountId: string, limit = 25): Promise<unknown> {
  return callDotApi(accountId, {
    method: 'GET',
    path: '/files/library/nodes',
    query: {
      limit: String(limit),
      include_pages: 'true'
    }
  })
}

export async function createDotPage(
  accountId: string,
  title: string,
  layout: 'document' | 'spatial' = 'document'
): Promise<unknown> {
  return callDotApi(accountId, {
    method: 'POST',
    path: '/pages',
    body: {
      title: title.trim() || 'Untitled Page',
      layout
    }
  })
}

export async function deleteDotPage(accountId: string, pageId: string): Promise<unknown> {
  return callDotApi(accountId, {
    method: 'DELETE',
    path: `/pages/${encodeURIComponent(pageId)}`
  })
}

// ============================================================================
// Dot Root Thread Status & Cross-Account Memory Export / Migration
// ============================================================================

/**
 * Whether Dot's root thread is still working. `null` means unknown (no
 * thread id, or the read failed); callers must not treat that as idle,
 * because idle triggers an automatic follow-up message.
 */
export async function isDotRootThreadBusy(accountId: string, threadId?: string, signal?: AbortSignal): Promise<boolean | null> {
  const acc = getStoredDotAccount(accountId)
  const tid = threadId || acc?.threadId
  if (!tid) return null
  try {
    const res = await withAppServerWs(
      accountId,
      ({ call }) => call('thread/read', { threadId: tid }),
      6_000,
      signal
    )
    return normalizeDotThreadBusy(res)
  } catch {
    return null
  }
}

/**
 * Export a portable Markdown memory snapshot for a Dot account:
 * - `mode === 'deep'`: asks Dot (`aeon`) in its Calpico Room to compile a structured `# Dot 记忆快照`
 *   distinguishing user-stated facts from account history, then merges global `/backend-api/memories` & `thread/goal`.
 * - `mode === 'fast'` (default): immediately extracts any existing `# Dot 记忆快照` from the room,
 *   global `/backend-api/memories`, `thread/goal/get`, and recent room context without waiting 35s.
 */
export async function exportDotMemorySnapshot(
  accountId: string,
  opts?: {
    mode?: 'fast' | 'deep'
    dotId?: string
    roomId?: string
    onActivity?: (code: string, text: string | undefined, busy: boolean) => void
  }
): Promise<DotMemorySnapshotResult> {
  const acc = await ensureValidDotAccount(accountId)
  const mode = opts?.mode ?? 'fast'

  if (mode === 'deep') {
    opts?.onActivity?.('thinking', '正在请求 Dot (aeon) 整理完整记忆快照…', true)
    await sendAndWatchDotRoomReply(accountId, {
      dotId: opts?.dotId ?? acc.activeDotId,
      roomId: opts?.roomId ?? acc.roomId,
      timeoutMs: 75_000,
      text: '请把你目前记得的所有关于我的信息整理成一份结构化的 Markdown 记忆快照（以 `# Dot 记忆快照` 开头，包含：1. 身份 2. 项目与技术栈 3. 语言与回复偏好 4. 待办与目标 5. 历史重要上下文），并区分我明确告诉你的信息与账号历史背景，方便我备份或跨账号迁移。',
      onActivity: opts?.onActivity
    }).catch(() => undefined)
  }

  const [memRes, goalRes, roomRes] = await Promise.all([
    callDotApi(accountId, { method: 'GET', path: '/memories' }).catch(() => null),
    getDotThreadGoal(accountId, acc.threadId).catch(() => null),
    listRoomMessages(accountId, {
      roomId: opts?.roomId ?? acc.roomId,
      dotId: opts?.dotId ?? acc.activeDotId,
      limit: 40
    }).catch(() => ({ roomId: acc.roomId || '', messages: [] as DotRoomMessage[] }))
  ])

  return formatDotMemorySnapshot(acc, accountId, memRes, goalRes, roomRes.messages, new Date().toISOString())
}

/**
 * Import / migrate a `# Dot 记忆快照` Markdown document into the target Dot account:
 * 1. Restores `thread/goal/set` if a goal is present.
 * 2. Sends a structured memory-injection turn to the target Dot's Calpico Room so Dot (`aeon`)
 *    persists the user's identity, projects, preferences, and context in its long-term memory.
 */
export async function importDotMemorySnapshot(
  accountId: string,
  opts: {
    markdown: string
    goal?: string
    botId?: string
    dotId?: string
    roomId?: string
    onActivity?: (code: string, text: string | undefined, busy: boolean) => void
    onMessage?: (msg: DotRoomMessage, done: boolean, stillBusy?: boolean, target?: DotTarget) => void
  }
): Promise<{
  roomId: string
  sentMessage: DotRoomMessage
  replies: DotRoomMessage[]
  goalRestored?: string
}> {
  const markdown = opts.markdown.trim()
  if (!markdown) {
    throw new DotApiError(400, '记忆快照内容不能为空')
  }

  const goalToRestore = dotSnapshotGoal(markdown, opts.goal)

  if (goalToRestore) {
    await setDotThreadGoal(accountId, goalToRestore).catch(() => undefined)
  }

  const injectionPrompt = [
    '【Dot 跨账号记忆迁移与上下文注入】',
    '以下是我从上一个 Dot 账号导出的 `# Dot 记忆快照`。请将其中关于我的身份、项目与技术栈、语言与回复偏好、待办与长期目标以及关键上下文完整记入你的长期记忆中，并在后续所有对话中直接沿用（请用简明中文回复确认你已记住的核心要点）：',
    '',
    markdown
  ].join('\n')

  const result = await sendAndWatchDotRoomReply(accountId, {
    botId: opts.botId,
    dotId: opts.dotId,
    roomId: opts.roomId,
    text: injectionPrompt,
    timeoutMs: 75_000,
    onActivity: opts.onActivity,
    onMessage: opts.onMessage
  })

  return {
    ...result,
    goalRestored: goalToRestore
  }
}

