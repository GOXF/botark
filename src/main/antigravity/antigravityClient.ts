/**
 * Electron main-process client for Google Antigravity Cloud Agents (`antigravity.google.com`).
 *
 * Calls `https://aicode.clients6.google.com/$rpc/google.gca.aicode.v1alpha.JetskiRemoteAgentProxyService/*`
 * through the account's isolated Electron session partition (`ses.fetch`), so per-account
 * proxies and Google session cookies are always honored automatically.
 *
 * Never logs cookie or auth-header values.
 */

import { session as electronSession } from 'electron'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { applyProxyToPartition } from '../muse/accountProxy'
import { partitionForAccount } from '../webContentsViewManager'
import {
  ANTIGRAVITY_API_KEY,
  ANTIGRAVITY_API_ORIGIN,
  ANTIGRAVITY_ORIGIN,
  ANTIGRAVITY_RPC_PREFIX,
  buildCancelCascadeReq,
  buildDeleteConversationReq,
  buildGetConversationReq,
  buildListConversationsReq,
  buildSapisidAuthHeader,
  buildSendUserCascadeMessageReq,
  buildStartCascadeReq,
  buildStreamAgentStateUpdatesReq,
  CASCADE_RUN_STATUS,
  cleanAntigravityChromeUserAgent,
  extractTranscriptFromSteps,
  extractTurnProgress,
  findAntigravityTurn,
  JspbStreamBodyParser,
  mergeTrajectorySteps,
  parseAgents,
  parseAvailableModels,
  parseConversationsList,
  parseEnvironments,
  parseGetConversationResponse,
  parseStartCascadeResponse,
  parseStreamUpdateResponse,
  parseUserProfile,
  parseWorkspaces,
  type AntigravityAgentInfo,
  type AntigravityConversationSummary,
  type AntigravityEnvironmentInfo,
  type AntigravityModelInfo,
  type AntigravityParsedStep,
  type AntigravityTranscriptMessage,
  type AntigravityTurnEvent,
  type AntigravityUserProfile,
  type AntigravityWorkspaceInfo
} from './antigravityProtocol'

export interface AntigravityAccountPrefs {
  modelEnum?: number
  modelDisplayName?: string
  capsuleId?: string
  agentPath?: string
}

interface ActiveRun {
  controller: AbortController
  cascadeId?: string
  cancel: () => void
}

const accountPrefs = new Map<string, AntigravityAccountPrefs>()
const activeRuns = new Map<string, ActiveRun>()
const pendingCancellations = new Map<string, Promise<unknown>>()

export function getAntigravityAccountPrefs(accountId: string): AntigravityAccountPrefs {
  return accountPrefs.get(accountId) ?? {}
}

export function setAntigravityAccountPrefs(
  accountId: string,
  patch: Partial<AntigravityAccountPrefs>
): AntigravityAccountPrefs {
  const next: AntigravityAccountPrefs = { ...getAntigravityAccountPrefs(accountId), ...patch }
  accountPrefs.set(accountId, next)
  return next
}

export function clearAntigravityAccountState(accountId: string): void {
  cancelAntigravityRun(accountId)
  accountPrefs.delete(accountId)
}

export function cancelAntigravityRun(accountId: string): void {
  const run = activeRuns.get(accountId)
  if (!run) return
  activeRuns.delete(accountId)
  run.controller.abort()
  if (run.cascadeId) {
    const signal = AbortSignal.timeout(ANTIGRAVITY_RPC_TIMEOUT_MS)
    const cancellation = withAntigravityDeadline(
      callAntigravityRpc(accountId, 'CancelCascade', buildCancelCascadeReq(run.cascadeId), signal), signal
    ).catch(() => undefined)
    pendingCancellations.set(accountId, cancellation)
    void cancellation.then(() => {
      if (pendingCancellations.get(accountId) === cancellation) pendingCancellations.delete(accountId)
    })
  }
  run.cancel()
}

export function cancelAllAntigravityRuns(target: string): void {
  if (target === '*') {
    for (const id of [...activeRuns.keys()]) cancelAntigravityRun(id)
  } else {
    cancelAntigravityRun(target)
  }
}

async function getPartitionCookies(accountId: string): Promise<Array<{ name: string; value: string }>> {
  const ses = electronSession.fromPartition(partitionForAccount(accountId))
  const [agyCookies, googleCookies] = await Promise.all([
    ses.cookies.get({ url: ANTIGRAVITY_ORIGIN }).catch(() => []),
    ses.cookies.get({ url: 'https://www.google.com' }).catch(() => [])
  ])
  const merged = new Map<string, string>()
  for (const c of googleCookies) merged.set(c.name, c.value)
  for (const c of agyCookies) merged.set(c.name, c.value)
  return [...merged.entries()].map(([name, value]) => ({ name, value }))
}

export async function listAntigravityCookieNames(accountId: string): Promise<string[]> {
  const cookies = await getPartitionCookies(accountId)
  return cookies.map((c) => c.name)
}

async function buildRequestHeaders(accountId: string): Promise<{
  ses: Electron.Session
  headers: Record<string, string>
} | null> {
  await applyProxyToPartition(accountId)
  const ses = electronSession.fromPartition(partitionForAccount(accountId))
  const cleanUa = cleanAntigravityChromeUserAgent(ses.getUserAgent())
  ses.setUserAgent(cleanUa)

  const cookies = await getPartitionCookies(accountId)
  const authHeader = buildSapisidAuthHeader(cookies, ANTIGRAVITY_ORIGIN)
  if (!authHeader) return null

  return {
    ses,
    headers: {
      'Content-Type': 'application/json+protobuf',
      Accept: '*/*',
      'X-User-Agent': 'grpc-web-javascript/0.1',
      'X-Goog-Api-Key': ANTIGRAVITY_API_KEY,
      'X-Goog-AuthUser': '0',
      Authorization: authHeader,
      Origin: ANTIGRAVITY_ORIGIN,
      Referer: `${ANTIGRAVITY_ORIGIN}/`,
      'User-Agent': cleanUa
    }
  }
}

export class AntigravityRpcError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly grpcCode?: number
  ) {
    super(message)
    this.name = 'AntigravityRpcError'
  }
}

function parseRpcErrorPayload(status: number, bodyText: string): AntigravityRpcError {
  try {
    const parsed = JSON.parse(bodyText) as unknown
    if (Array.isArray(parsed) && typeof parsed[0] === 'number') {
      const code = parsed[0]
      const msg = typeof parsed[1] === 'string' && parsed[1] ? parsed[1] : `gRPC error ${code}`
      const effectiveStatus = code === 16 ? 401 : code === 7 ? 403 : status
      return new AntigravityRpcError(effectiveStatus, msg.slice(0, 260), code)
    }
  } catch {
    /* fall through */
  }
  return new AntigravityRpcError(status, `Antigravity RPC HTTP ${status}`)
}

const ANTIGRAVITY_RPC_TIMEOUT_MS = 25_000

export async function callAntigravityRpc(
  accountId: string,
  method: string,
  bodyArray: unknown[] = [],
  signal?: AbortSignal
): Promise<unknown> {
  signal?.throwIfAborted()
  const setupDeadline = AbortSignal.timeout(ANTIGRAVITY_RPC_TIMEOUT_MS)
  const prepared = await withAntigravityDeadline(buildRequestHeaders(accountId),
    signal ? AbortSignal.any([signal, setupDeadline]) : setupDeadline)
  signal?.throwIfAborted()
  if (!prepared) {
    throw new AntigravityRpcError(401, 'Not signed in to Google Antigravity (missing SAPISID cookies)', 16)
  }
  const url = `${ANTIGRAVITY_API_ORIGIN}${ANTIGRAVITY_RPC_PREFIX}/${method}`
  const maxAttempts = method === 'StartCascade' || method === 'SendUserCascadeMessage' ? 1 : 2
  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(400 * attempt, undefined, { signal })
    }
    const deadline = AbortSignal.timeout(ANTIGRAVITY_RPC_TIMEOUT_MS)
    const effectiveSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
    try {
      const res = await prepared.ses.fetch(url, {
        method: 'POST',
        headers: prepared.headers,
        body: JSON.stringify(bodyArray),
        signal: effectiveSignal
      })
      const status = Number(res.headers.get('grpc-status') || 0)
      if (status) {
        void res.body?.cancel().catch(() => undefined)
        throw new AntigravityStreamStatusError(status, res.headers.get('grpc-message') || '')
      }
      const text = await res.text()
      effectiveSignal.throwIfAborted()
      if (!res.ok) {
        const err = parseRpcErrorPayload(res.status, text)
        if ((res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) && attempt + 1 < maxAttempts) {
          lastError = err
          continue
        }
        throw err
      }
      if (!text.trim()) return []
      try {
        return JSON.parse(text)
      } catch {
        throw new AntigravityRpcError(502, `Invalid JSON response from Antigravity ${method}`)
      }
    } catch (error) {
      if (error instanceof AntigravityRpcError) throw error
      lastError = error
      if (signal?.aborted || attempt + 1 >= maxAttempts) {
        const msg =
          error instanceof Error && error.name === 'TimeoutError'
            ? `Antigravity ${method} timed out`
            : error instanceof Error
              ? error.message
              : String(error)
        throw new AntigravityRpcError(504, msg)
      }
    }
  }
  throw lastError instanceof Error ? lastError : new AntigravityRpcError(502, `Antigravity ${method} failed`)
}

export type AntigravitySessionProbe =
  | { signedIn: true; profile: AntigravityUserProfile }
  | { signedIn: false; reason: 'no-cookies' | 'unauthorized' | 'network'; message?: string }

export async function probeAntigravitySession(accountId: string): Promise<AntigravitySessionProbe> {
  try {
    const raw = await callAntigravityRpc(accountId, 'GetUserProfile', [])
    const profile = parseUserProfile(raw)
    if (!profile) {
      return { signedIn: false, reason: 'unauthorized', message: 'Empty Antigravity user profile' }
    }
    return { signedIn: true, profile }
  } catch (error) {
    if (error instanceof AntigravityRpcError && error.grpcCode === 16 && error.message.includes('missing SAPISID cookies')) {
      return { signedIn: false, reason: 'no-cookies' }
    }
    if (error instanceof AntigravityRpcError && (error.status === 401 || error.status === 403 || error.grpcCode === 16)) {
      return { signedIn: false, reason: 'unauthorized', message: error.message }
    }
    return {
      signedIn: false,
      reason: 'network',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function fetchAntigravityProfile(accountId: string): Promise<AntigravityUserProfile | null> {
  const raw = await callAntigravityRpc(accountId, 'GetUserProfile', [])
  return parseUserProfile(raw)
}

export async function fetchAntigravityModels(accountId: string): Promise<AntigravityModelInfo[]> {
  const raw = await callAntigravityRpc(accountId, 'ListAvailableModels', [])
  return parseAvailableModels(raw)
}

export async function fetchAntigravityAgents(accountId: string): Promise<AntigravityAgentInfo[]> {
  const raw = await callAntigravityRpc(accountId, 'ListAgents', [])
  return parseAgents(raw)
}

export async function fetchAntigravityEnvironments(accountId: string): Promise<AntigravityEnvironmentInfo[]> {
  const raw = await callAntigravityRpc(accountId, 'ListEnvironments', [])
  return parseEnvironments(raw)
}

export async function fetchAntigravityWorkspaces(accountId: string): Promise<AntigravityWorkspaceInfo[]> {
  const raw = await callAntigravityRpc(accountId, 'ListWorkspaces', [])
  return parseWorkspaces(raw)
}

export async function fetchAntigravityConversations(
  accountId: string,
  pageSize = 30
): Promise<AntigravityConversationSummary[]> {
  const raw = await callAntigravityRpc(accountId, 'ListConversations', buildListConversationsReq(pageSize))
  return parseConversationsList(raw).conversations
}

export async function fetchAntigravityTranscript(
  accountId: string,
  conversationId: string
): Promise<{
  messages: AntigravityTranscriptMessage[]
  runStatus: number
  fullyIdle: boolean
}> {
  const raw = await callAntigravityRpc(
    accountId,
    'GetConversation',
    buildGetConversationReq(conversationId, 2)
  )
  const update = parseGetConversationResponse(raw)
  if (!update) return { messages: [], runStatus: CASCADE_RUN_STATUS.IDLE, fullyIdle: true }
  const map = new Map<number, AntigravityParsedStep>()
  mergeTrajectorySteps(map, update)
  return {
    messages: extractTranscriptFromSteps(map, conversationId),
    runStatus: update.runStatus,
    fullyIdle: update.fullyIdle
  }
}

export async function deleteAntigravityConversation(
  accountId: string,
  conversationId: string
): Promise<void> {
  await callAntigravityRpc(accountId, 'DeleteConversation', buildDeleteConversationReq(conversationId))
}

const STREAM_IDLE_TIMEOUT_MS = 15_000
const TURN_TIMEOUT_MS = 180_000

class AntigravityStreamStatusError extends AntigravityRpcError {
  constructor(code: number, message: string) {
    super(code === 16 ? 401 : code === 7 ? 403 : 502, message || `Antigravity gRPC error ${code}`, code)
  }
}

async function withAntigravityDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void
  const deadline = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export interface SendAntigravityMessageParams {
  accountId: string
  conversationId: string
  sessionId?: string
  text: string
  clientMessageId?: string
  onEvent: (event: AntigravityTurnEvent) => void
}

export async function sendAndStreamAntigravityMessage(
  params: SendAntigravityMessageParams
): Promise<{ cascadeId: string; messageId: string }> {
  const { accountId, conversationId, text } = params
  const messageId = params.clientMessageId || randomUUID()
  cancelAntigravityRun(accountId)

  const controller = new AbortController()
  const run: ActiveRun = {
    controller,
    cancel: () => params.onEvent({
      type: 'stream', accountId, conversationId, sessionId: run.cascadeId, messageId,
      text: '', done: true, error: { status: 499, message: 'Antigravity turn cancelled' }
    })
  }
  activeRuns.set(accountId, run)
  const ownsRun = () => activeRuns.get(accountId) === run && !controller.signal.aborted
  const onEvent: SendAntigravityMessageParams['onEvent'] = (event) => {
    if (ownsRun()) params.onEvent(event)
  }

  const prefs = getAntigravityAccountPrefs(accountId)
  let cascadeId = params.sessionId?.trim() || ''

  try {
    const cancellation = pendingCancellations.get(accountId)
    if (cancellation) await withAntigravityDeadline(cancellation, controller.signal)
    controller.signal.throwIfAborted()
    // Cancel can arrive while a continuation is still waiting for its acknowledgment.
    if (cascadeId) run.cascadeId = cascadeId
    onEvent({
      type: 'activity',
      accountId,
      messageId,
      activityCode: 'thinking',
      activityText: cascadeId ? 'Sending to Antigravity…' : 'Starting Antigravity cloud agent…',
      busy: true
    })

    const method = cascadeId ? 'SendUserCascadeMessage' : 'StartCascade'
    const payload = cascadeId
      ? buildSendUserCascadeMessageReq({
          cascadeId, text, modelEnum: prefs.modelEnum, continueExecution: true, clientMessageId: messageId
        })
      : buildStartCascadeReq({
          text, modelEnum: prefs.modelEnum, capsuleId: prefs.capsuleId, agentPath: prefs.agentPath,
          clientMessageId: messageId
        })
    const response = await callAntigravityRpc(accountId, method, payload, controller.signal)
    controller.signal.throwIfAborted()
    cascadeId = parseStartCascadeResponse(response).cascadeId || cascadeId
    if (!cascadeId) throw new AntigravityRpcError(502, 'Antigravity StartCascade returned an empty cascadeId')

    run.cascadeId = cascadeId
    void streamCascadeUntilDone({
      accountId, conversationId, cascadeId, messageId, signal: controller.signal, onEvent
    }).catch((error: unknown) => {
      if (!ownsRun()) return
      const status = error instanceof AntigravityRpcError ? error.status
        : (error instanceof Error && error.name === 'TimeoutError' ? 504 : 502)
      const message = status === 504 ? 'Antigravity timed out while waiting for its response'
        : error instanceof Error ? error.message : String(error)
      onEvent({
        type: 'stream', accountId, conversationId, sessionId: cascadeId, messageId,
        text: '', done: true, error: { status, message }
      })
    }).finally(() => {
      if (activeRuns.get(accountId) === run) activeRuns.delete(accountId)
    })

    return { cascadeId, messageId }
  } catch (error) {
    onEvent({ type: 'activity', accountId, messageId, activityCode: 'idle', activityText: null, busy: false })
    if (activeRuns.get(accountId) === run) activeRuns.delete(accountId)
    throw error
  }
}

async function streamCascadeUntilDone(opts: {
  accountId: string
  conversationId: string
  cascadeId: string
  messageId: string
  signal: AbortSignal
  onEvent: (event: AntigravityTurnEvent) => void
}): Promise<void> {
  const { accountId, conversationId, cascadeId, messageId, signal, onEvent } = opts
  const steps = new Map<number, AntigravityParsedStep>()
  const streamEvent = { type: 'stream' as const, accountId, conversationId, sessionId: cascadeId, messageId }
  let progress: ReturnType<typeof extractTurnProgress> | undefined
  let lastSentText = ''
  let lastToolSig = ''
  let lastActivity = ''
  let finished = false
  let waiting = false
  let idleWithoutTurn = 0
  let deadline = AbortSignal.timeout(TURN_TIMEOUT_MS)
  let resumeToken: string | undefined

  const emitActivity = (code: string, activityText: string, busy = true) => {
    const signature = `${code}:${activityText}`
    if (signature === lastActivity) return
    lastActivity = signature
    onEvent({ type: 'activity', accountId, messageId, activityCode: code, activityText, busy })
  }
  const publishProgress = () => {
    if (!progress) return
    const signature = JSON.stringify(progress.tools)
    if (progress.text === lastSentText && signature === lastToolSig) return
    lastSentText = progress.text
    lastToolSig = signature
    onEvent({ ...streamEvent, text: progress.text, tools: progress.tools, done: false })
  }

  const applyUpdate = (update: ReturnType<typeof parseStreamUpdateResponse>) => {
    if (!update || (update.conversationId && update.conversationId !== cascadeId)) return
    resumeToken = update.resumeToken ?? resumeToken
    mergeTrajectorySteps(steps, update)
    const turn = findAntigravityTurn(steps, messageId)
    if (!turn) {
      if (update.fullyIdle || update.runStatus === CASCADE_RUN_STATUS.IDLE) idleWithoutTurn++
      else idleWithoutTurn = 0
      return
    }
    idleWithoutTurn = 0
    const { userStepIndex, nextUserStepIndex } = turn
    if (update.steps.length || !progress) {
      progress = extractTurnProgress(steps, userStepIndex, nextUserStepIndex)
    }
    const hasApproval = update.waitingStepIndices.some((index) => index > userStepIndex && index < nextUserStepIndex)
    if (hasApproval) {
      const enteringApproval = !waiting
      finished = false
      waiting = true
      if (enteringApproval) {
        emitActivity('needs_approval', 'Waiting for confirmation in Antigravity Web', false)
        onEvent({
          ...streamEvent, text: progress.text, tools: progress.tools, done: false, waitingForApproval: true
        })
      } else {
        publishProgress()
      }
      return
    }
    if (waiting) {
      waiting = false
      deadline = AbortSignal.timeout(TURN_TIMEOUT_MS)
    }
    finished = update.fullyIdle || update.runStatus === CASCADE_RUN_STATUS.IDLE || nextUserStepIndex < Infinity
    if (!finished) {
      emitActivity(
        progress.tools.some((tool) => tool.status === 'running') ? 'tool' : 'thinking',
        progress.activityText || (progress.text ? 'Responding…' : 'Thinking…')
      )
      publishProgress()
    }
  }

  // A reconnectable stream attempt and its idle deadline include the response headers.
  const readStream = async (overall: AbortSignal) => {
    const transport = new AbortController()
    const streamSignal = AbortSignal.any([overall, transport.signal])
    const withIdleDeadline = <T>(operation: Promise<T>) =>
      withAntigravityDeadline(operation, AbortSignal.any([streamSignal, AbortSignal.timeout(STREAM_IDLE_TIMEOUT_MS)]))
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let body: ReadableStream<Uint8Array> | null = null
    try {
      const prepared = await withIdleDeadline(buildRequestHeaders(accountId))
      if (!prepared) throw new AntigravityRpcError(401, 'Not signed in to Antigravity')
      streamSignal.throwIfAborted()
      const url = `${ANTIGRAVITY_API_ORIGIN}${ANTIGRAVITY_RPC_PREFIX}/StreamAgentStateUpdates`
      const response = await withIdleDeadline(prepared.ses.fetch(url, {
        method: 'POST',
        headers: prepared.headers,
        body: JSON.stringify(buildStreamAgentStateUpdatesReq(cascadeId, resumeToken, 2)),
        signal: streamSignal
      }))
      body = response.body
      if (!response.ok) throw parseRpcErrorPayload(response.status, await withIdleDeadline(response.text()))
      const headerStatus = Number(response.headers.get('grpc-status') || 0)
      if (headerStatus) throw new AntigravityStreamStatusError(headerStatus, response.headers.get('grpc-message') || '')
      if (!body) throw new AntigravityRpcError(502, 'Antigravity stream has no response body')
      reader = body.getReader()
      const decoder = new TextDecoder()
      const parser = new JspbStreamBodyParser()
      const handleChunk = (chunk: string) => {
        for (const event of parser.push(chunk)) {
          if (event.kind === 'status') {
            if (event.code !== 0) throw new AntigravityStreamStatusError(event.code, event.message)
          } else {
            applyUpdate(parseStreamUpdateResponse(event.payload))
          }
        }
      }
      for (;;) {
        const { value, done } = await withIdleDeadline(reader.read())
        if (done) {
          handleChunk(decoder.decode())
          parser.finish()
          return
        }
        if (value) handleChunk(decoder.decode(value, { stream: true }))
      }
    } finally {
      transport.abort()
      if (reader) {
        try {
          void reader.cancel().catch(() => undefined)
        } finally {
          reader.releaseLock()
        }
      } else if (body && !body.locked) {
        void body.cancel().catch(() => undefined)
      }
    }
  }

  try {
    await readStream(AbortSignal.any([signal, deadline]))
  } catch (error) {
    if (error instanceof AntigravityStreamStatusError ||
        (error instanceof AntigravityRpcError && (error.grpcCode || error.status === 401 || error.status === 403))) {
      throw error
    }
    // Verify completion with GetConversation if the streaming transport ended early.
    finished = false
  }

  let pollFailures = 0
  while (!finished) {
    signal.throwIfAborted()
    const pollSignal = waiting
      ? AbortSignal.any([signal, AbortSignal.timeout(35_000)])
      : AbortSignal.any([signal, deadline])
    pollSignal.throwIfAborted()
    await sleep(waiting ? 5_000 : 1_200, undefined, { signal: pollSignal })
    try {
      const snapshot = await withAntigravityDeadline(
        callAntigravityRpc(accountId, 'GetConversation', buildGetConversationReq(cascadeId, 2), pollSignal),
        pollSignal
      )
      applyUpdate(parseGetConversationResponse(snapshot))
      pollFailures = 0
    } catch (error) {
      if (signal.aborted || (error instanceof AntigravityRpcError &&
          (error.grpcCode || error.status === 401 || error.status === 403))) throw error
      if (!waiting && (++pollFailures >= 5 || deadline.aborted)) throw deadline.reason ?? error
    }
    if (idleWithoutTurn >= 4) {
      throw new AntigravityRpcError(502, 'Antigravity did not return the submitted user step')
    }
  }
  signal.throwIfAborted()
  onEvent({ ...streamEvent, text: progress?.text ?? '', tools: progress?.tools, done: true })
}
