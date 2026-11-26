/**
 * Pure protocol layer for Google Antigravity Cloud Agents (`https://antigravity.google.com/`).
 *
 * Speaks Google's first-party `application/json+protobuf` (JSPB) gRPC-Web RPCs
 * against `https://aicode.clients6.google.com/$rpc/google.gca.aicode.v1alpha.JetskiRemoteAgentProxyService/*`,
 * authenticated with Google first-party cookies + `SAPISIDHASH` / `SAPISID1PHASH` / `SAPISID3PHASH`.
 *
 * Zero Electron imports so every encoder, decoder, stream parser, and auth helper is unit-testable.
 */

import { createHash } from 'node:crypto'
import type { AntigravityMainEvent } from '@shared/ipc'
import { cleanChromeUserAgentForGoogle } from '../googleOAuthUaGuard'

export const ANTIGRAVITY_ORIGIN = 'https://antigravity.google.com'
export const ANTIGRAVITY_API_ORIGIN = 'https://aicode.clients6.google.com'
export const ANTIGRAVITY_API_KEY = 'AIzaSyCUicsvglkMf8CM2MPlGjopIcIxu3VJEDU'
export const ANTIGRAVITY_RPC_PREFIX = '/$rpc/google.gca.aicode.v1alpha.JetskiRemoteAgentProxyService'
export const ANTIGRAVITY_COOKIE_ORIGINS = [
  ANTIGRAVITY_API_ORIGIN,
  'https://accounts.google.com',
  'https://www.google.com',
  ANTIGRAVITY_ORIGIN
] as const

const ALLOWED_DOMAINS = [
  'antigravity.google.com',
  'antigravity.google',
  'google.com',
  'googleusercontent.com',
  'gstatic.com',
  'googleapis.com',
  'youtube.com',
  'chromiumapp.org'
] as const

export const CASCADE_RUN_STATUS = {
  UNSPECIFIED: 0,
  IDLE: 1,
  RUNNING: 2,
  CANCELING: 3,
  BUSY: 4
} as const

export const CORTEX_STEP_TYPE = {
  UNSPECIFIED: 0,
  FINISH: 2,
  CODE_ACTION: 5,
  GREP_SEARCH: 7,
  VIEW_FILE: 8,
  LIST_DIRECTORY: 9,
  USER_INPUT: 14,
  PLANNER_RESPONSE: 15,
  ERROR_MESSAGE: 17,
  RUN_COMMAND: 21,
  FIND: 25,
  READ_URL_CONTENT: 31,
  SEARCH_WEB: 33,
  MCP_TOOL: 38,
  NOTIFY_USER: 82,
  FILE_CHANGE: 86,
  GENERATE_IMAGE: 91,
  INVOKE_SUBAGENT: 127,
  ASK_QUESTION: 138
} as const

export const CORTEX_STEP_STATUS = {
  UNSPECIFIED: 0,
  PENDING: 1,
  RUNNING: 2,
  DONE: 3,
  INVALID: 4,
  CLEARED: 5,
  CANCELED: 6,
  ERROR: 7,
  GENERATING: 8,
  WAITING: 9,
  QUEUED: 11,
  INTERRUPTED: 12
} as const

export interface AntigravityUserProfile {
  email?: string
  planId?: string
  planDisplayName?: string
}

export interface AntigravityModelInfo {
  modelEnum: number
  modelId: string
  displayName: string
  description?: string
  isDefault: boolean
  remainingFraction?: number
  resetTimeMs?: number
}

export interface AntigravityAgentInfo {
  agentId: string
  displayName: string
  executionIdentity?: string
  status: number
  capsuleId?: string
  projectId?: string
  updateTimeMs?: number
}

export interface AntigravityEnvironmentInfo {
  capsuleId?: string
  isDefault: boolean
  connectionState: number
  tags: string[]
}

export interface AntigravityWorkspaceInfo {
  workspaceUri: string
  displayName: string
  projectId?: string
  archived: boolean
  updateTimeMs?: number
}

export interface AntigravityConversationSummary {
  conversationId: string
  title: string
  stepCount: number
  status: number
  statusLabel: 'idle' | 'running' | 'canceling' | 'busy' | 'unknown'
  updatedAtMs: number
  createdAtMs: number
  cloud: boolean
  waitingCount: number
}

export interface AntigravityParsedStep {
  index: number
  type: number
  status: number
  createdAtMs: number
  userText?: string
  clientMessageId?: string
  assistantText?: string
  thinkingText?: string
  notifyText?: string
  errorText?: string
  toolName?: string
  toolSummary?: string
  toolAction?: string
  messageId?: string
}

export type AntigravityTurnEvent = AntigravityMainEvent & {
  messageId?: string
  waitingForApproval?: boolean
  error?: { status: number; message: string }
}

export interface AntigravityStateUpdate {
  conversationId: string
  trajectoryId: string
  runStatus: number
  fullyIdle: boolean
  resumeToken?: string
  totalSteps: number
  steps: AntigravityParsedStep[]
  waitingStepIndices: number[]
}

export interface AntigravityTranscriptMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  tools?: Array<{ id: string; name: string; status: 'running' | 'completed' | 'errored'; detail?: string }>
}

function matchesHostSuffix(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

export function isAllowedAntigravityUrl(url: string): boolean {
  if (!url || url === 'about:blank') return true
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    return ALLOWED_DOMAINS.some((domain) => matchesHostSuffix(host, domain))
  } catch {
    return false
  }
}

export const cleanAntigravityChromeUserAgent = cleanChromeUserAgentForGoogle

export function isAntigravitySigningCookie(name: string): boolean {
  return name === 'SAPISID' || name === '__Secure-1PAPISID' || name === '__Secure-3PAPISID'
}

export function parseAntigravityAuthUser(value: string | null | undefined): string | undefined {
  return value && /^(?:0|[1-9]\d{0,2})$/.test(value) ? value : undefined
}

export function antigravityAuthUserFromUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl)
    if (url.origin !== ANTIGRAVITY_ORIGIN && url.origin !== ANTIGRAVITY_API_ORIGIN) return
    return parseAntigravityAuthUser(url.searchParams.get('authuser') ?? /^\/u\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1])
  } catch {
    return undefined
  }
}

function sha1Hex(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex')
}

function formatSapisidToken(scheme: string, cookieValue: string, origin: string, tsSec: number): string {
  const digest = sha1Hex(`${tsSec} ${cookieValue} ${origin}`)
  return `${scheme} ${tsSec}_${digest}`
}

/**
 * Compute Google's first-party Authorization header (`SAPISIDHASH ... SAPISID1PHASH ... SAPISID3PHASH ...`)
 * matching `_.Ah.auth_firstparty.getAuthHeaderValueForFirstParty([])` in `antigravity.google.com`.
 */
export function buildSapisidAuthHeader(
  cookies: ReadonlyArray<{ name: string; value: string }>,
  origin: string = ANTIGRAVITY_ORIGIN,
  nowSec: number = Math.floor(Date.now() / 1000)
): string | null {
  const map = new Map<string, string>()
  for (const c of cookies) {
    if (c.name && c.value) map.set(c.name, c.value)
  }
  const sapisid = map.get('SAPISID') || map.get('__Secure-3PAPISID')
  const sapisid1p = map.get('__Secure-1PAPISID')
  const sapisid3p = map.get('__Secure-3PAPISID')

  const parts: string[] = []
  if (sapisid) parts.push(formatSapisidToken('SAPISIDHASH', sapisid, origin, nowSec))
  if (sapisid1p) parts.push(formatSapisidToken('SAPISID1PHASH', sapisid1p, origin, nowSec))
  if (sapisid3p) parts.push(formatSapisidToken('SAPISID3PHASH', sapisid3p, origin, nowSec))
  return parts.length > 0 ? parts.join(' ') : null
}

/** Set a 1-based protobuf field index on a JSPB array (filling gaps with null). */
function setField(arr: unknown[], fieldNumber: number, value: unknown): void {
  if (value === undefined) return
  const idx = fieldNumber - 1
  while (arr.length < idx) arr.push(null)
  arr[idx] = value
}

export function buildListConversationsReq(pageSize = 30, pageToken?: string): unknown[] {
  const req: unknown[] = []
  if (pageToken) setField(req, 1, pageToken)
  if (pageSize > 0) setField(req, 2, pageSize)
  return req
}

export function buildGetConversationReq(conversationId: string, verbosity = 2): unknown[] {
  const req: unknown[] = []
  setField(req, 1, conversationId)
  setField(req, 5, verbosity)
  return req
}

export function buildStreamAgentStateUpdatesReq(
  conversationId: string,
  resumeToken?: string,
  verbosity = 2
): unknown[] {
  const req: unknown[] = []
  setField(req, 1, conversationId)
  setField(req, 4, verbosity)
  if (resumeToken) setField(req, 5, resumeToken)
  return req
}

export function buildStartCascadeReq(opts: {
  text: string
  modelEnum?: number
  capsuleId?: string
  executionIdentity?: string
  workspaceUris?: string[]
  title?: string
  clientMessageId?: string
  agentPath?: string
}): unknown[] {
  const req: unknown[] = []
  setField(req, 2, opts.text)
  if (opts.workspaceUris && opts.workspaceUris.length > 0) {
    setField(req, 4, opts.workspaceUris)
  }
  if (opts.capsuleId || opts.executionIdentity) {
    const env: unknown[] = []
    if (opts.capsuleId) setField(env, 1, [opts.capsuleId])
    if (opts.executionIdentity) setField(env, 2, opts.executionIdentity)
    setField(req, 5, env)
  }
  if (opts.modelEnum && opts.modelEnum > 0) {
    const cfg: unknown[] = []
    setField(cfg, 1, opts.modelEnum)
    setField(req, 6, cfg)
  }
  // Field 7: repeated TextOrScopeItem (field 1 = text)
  setField(req, 7, [[opts.text]])
  if (opts.title) setField(req, 12, opts.title)
  if (opts.clientMessageId) setField(req, 14, opts.clientMessageId)
  if (opts.agentPath) setField(req, 15, opts.agentPath)
  return req
}

export function buildSendUserCascadeMessageReq(opts: {
  cascadeId: string
  text: string
  modelEnum?: number
  continueExecution?: boolean
  clientMessageId?: string
}): unknown[] {
  const req: unknown[] = []
  setField(req, 1, opts.cascadeId)
  setField(req, 2, opts.text)
  // Field 4: repeated TextOrScopeItem (field 1 = text)
  setField(req, 4, [[opts.text]])
  if (opts.continueExecution) setField(req, 6, true)
  if (opts.modelEnum && opts.modelEnum > 0) {
    const cfg: unknown[] = []
    setField(cfg, 1, opts.modelEnum)
    setField(req, 7, cfg)
  }
  if (opts.clientMessageId) setField(req, 13, opts.clientMessageId)
  return req
}

export function buildCancelCascadeReq(cascadeId: string, reason = 'Cancelled by user'): unknown[] {
  const req: unknown[] = []
  setField(req, 1, cascadeId)
  setField(req, 2, reason)
  return req
}

export function buildDeleteConversationReq(conversationId: string): unknown[] {
  return [conversationId]
}

// --- Safe JSPB getters (1-based proto field numbers) ---

function asArr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined
}

function getField(arr: unknown[] | undefined, fieldNumber: number): unknown {
  if (!arr) return undefined
  return arr[fieldNumber - 1]
}

function getStr(arr: unknown[] | undefined, fieldNumber: number): string {
  const v = getField(arr, fieldNumber)
  return typeof v === 'string' ? v : ''
}

function getNum(arr: unknown[] | undefined, fieldNumber: number): number {
  const v = getField(arr, fieldNumber)
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return 0
}

function getBool(arr: unknown[] | undefined, fieldNumber: number): boolean {
  const v = getField(arr, fieldNumber)
  return v === true || v === 1
}

function parseTimestampMs(raw: unknown): number {
  const a = asArr(raw)
  if (!a) return 0
  const seconds = getNum(a, 1)
  const nanos = getNum(a, 2)
  if (!seconds) return 0
  return Math.floor(seconds * 1000 + nanos / 1_000_000)
}

function parseMicrosMs(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw / 1000)
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = Number(raw)
    if (Number.isFinite(n)) return Math.floor(n / 1000)
  }
  return 0
}

export function parseUserProfile(raw: unknown): AntigravityUserProfile | null {
  const a = asArr(raw)
  if (!a) return null
  const email = getStr(a, 1).trim() || undefined
  const plan = asArr(getField(a, 2))
  const planId = getStr(plan, 1).trim() || undefined
  const planDisplayName = getStr(plan, 2).trim() || undefined
  if (!email && !planId && !planDisplayName) return null
  return { email, planId, planDisplayName }
}

export function parseAvailableModels(raw: unknown): AntigravityModelInfo[] {
  const root = asArr(raw)
  const list = asArr(getField(root, 1))
  if (!list) return []
  const models: AntigravityModelInfo[] = []
  for (const item of list) {
    const m = asArr(item)
    if (!m) continue
    const modelEnum = getNum(m, 1)
    const displayName = getStr(m, 2)
    const description = getStr(m, 3) || undefined
    const isDefault = getBool(m, 4)
    const quota = asArr(getField(m, 5))
    const remRaw = getField(quota, 1)
    const remainingFraction = typeof remRaw === 'number' && Number.isFinite(remRaw) ? remRaw : undefined
    const resetTimeMs = parseTimestampMs(getField(quota, 2)) || undefined
    const modelId = getStr(m, 6) || (modelEnum ? `model_${modelEnum}` : displayName)
    if (!displayName && !modelId) continue
    models.push({
      modelEnum,
      modelId,
      displayName: displayName || modelId,
      description,
      isDefault,
      remainingFraction,
      resetTimeMs
    })
  }
  return models
}

export function parseAgents(raw: unknown): AntigravityAgentInfo[] {
  const root = asArr(raw)
  const list = asArr(getField(root, 1))
  if (!list) return []
  const out: AntigravityAgentInfo[] = []
  for (const item of list) {
    const a = asArr(item)
    if (!a) continue
    const agentId = getStr(a, 1)
    if (!agentId) continue
    out.push({
      agentId,
      displayName: getStr(a, 2) || agentId,
      executionIdentity: getStr(a, 3) || undefined,
      status: getNum(a, 4),
      capsuleId: getStr(a, 5) || undefined,
      updateTimeMs: parseMicrosMs(getField(a, 7)) || undefined,
      projectId: getStr(a, 12) || undefined
    })
  }
  return out
}

export function parseEnvironments(raw: unknown): AntigravityEnvironmentInfo[] {
  const root = asArr(raw)
  const list = asArr(getField(root, 1))
  if (!list) return []
  const out: AntigravityEnvironmentInfo[] = []
  for (const item of list) {
    const e = asArr(item)
    if (!e) continue
    const capsule = asArr(getField(e, 1))
    const capsuleId = getStr(capsule, 1) || undefined
    const tagsRaw = asArr(getField(capsule, 2))
    const tags = (tagsRaw ?? []).filter((t): t is string => typeof t === 'string')
    out.push({
      capsuleId,
      isDefault: getBool(e, 2),
      connectionState: getNum(e, 4),
      tags
    })
  }
  return out
}

export function parseWorkspaces(raw: unknown): AntigravityWorkspaceInfo[] {
  const root = asArr(raw)
  const list = asArr(getField(root, 1))
  if (!list) return []
  const out: AntigravityWorkspaceInfo[] = []
  for (const item of list) {
    const w = asArr(item)
    if (!w) continue
    const workspaceUri = getStr(w, 1)
    if (!workspaceUri) continue
    out.push({
      workspaceUri,
      displayName: getStr(w, 2) || workspaceUri,
      updateTimeMs: parseMicrosMs(getField(w, 3)) || undefined,
      projectId: getStr(w, 4) || undefined,
      archived: getBool(w, 6)
    })
  }
  return out
}

export function runStatusToLabel(status: number): AntigravityConversationSummary['statusLabel'] {
  switch (status) {
    case CASCADE_RUN_STATUS.IDLE:
      return 'idle'
    case CASCADE_RUN_STATUS.RUNNING:
      return 'running'
    case CASCADE_RUN_STATUS.CANCELING:
      return 'canceling'
    case CASCADE_RUN_STATUS.BUSY:
      return 'busy'
    default:
      return 'unknown'
  }
}

export function parseConversationsList(raw: unknown): {
  conversations: AntigravityConversationSummary[]
  nextPageToken?: string
} {
  const root = asArr(raw)
  if (!root) return { conversations: [] }
  const list = asArr(getField(root, 1)) ?? []
  const nextPageToken = getStr(root, 2) || undefined
  const conversations: AntigravityConversationSummary[] = []
  for (const item of list) {
    const c = asArr(item)
    if (!c) continue
    const conversationId = getStr(c, 4)
    if (!conversationId) continue
    const title = getStr(c, 1) || 'Untitled conversation'
    const stepCount = getNum(c, 2)
    const updatedAtMs = parseTimestampMs(getField(c, 3)) || parseTimestampMs(getField(c, 10)) || Date.now()
    const createdAtMs = parseTimestampMs(getField(c, 7)) || updatedAtMs
    const status = getNum(c, 5)
    const waiting = asArr(getField(c, 8)) ?? []
    const cloud = getBool(c, 27)
    conversations.push({
      conversationId,
      title,
      stepCount,
      status,
      statusLabel: runStatusToLabel(status),
      updatedAtMs,
      createdAtMs,
      cloud,
      waitingCount: waiting.length
    })
  }
  conversations.sort((a, b) => b.updatedAtMs - a.updatedAtMs)
  return { conversations, nextPageToken }
}

export function parseStartCascadeResponse(raw: unknown): { cascadeId: string } {
  const root = asArr(raw)
  return { cascadeId: getStr(root, 1) }
}

function extractItemsText(itemsRaw: unknown): string {
  const list = asArr(itemsRaw)
  if (!list) return ''
  const parts: string[] = []
  for (const it of list) {
    const a = asArr(it)
    const t = getStr(a, 1)
    if (t) parts.push(t)
  }
  return parts.join('\n').trim()
}

function stepTypeFallbackName(type: number): string {
  switch (type) {
    case CORTEX_STEP_TYPE.RUN_COMMAND:
      return 'run_command'
    case CORTEX_STEP_TYPE.VIEW_FILE:
      return 'view_file'
    case CORTEX_STEP_TYPE.LIST_DIRECTORY:
      return 'list_dir'
    case CORTEX_STEP_TYPE.GREP_SEARCH:
      return 'grep_search'
    case CORTEX_STEP_TYPE.FIND:
      return 'find_by_name'
    case CORTEX_STEP_TYPE.SEARCH_WEB:
      return 'search_web'
    case CORTEX_STEP_TYPE.READ_URL_CONTENT:
      return 'read_url'
    case CORTEX_STEP_TYPE.CODE_ACTION:
    case CORTEX_STEP_TYPE.FILE_CHANGE:
      return 'edit_file'
    case CORTEX_STEP_TYPE.MCP_TOOL:
      return 'mcp_tool'
    case CORTEX_STEP_TYPE.INVOKE_SUBAGENT:
      return 'subagent'
    case CORTEX_STEP_TYPE.GENERATE_IMAGE:
      return 'generate_image'
    default:
      return 'tool'
  }
}

export function parseCortexStep(rawStep: unknown, index: number): AntigravityParsedStep | null {
  const step = asArr(rawStep)
  if (!step) return null
  const type = getNum(step, 1)
  const status = getNum(step, 4)
  const meta = asArr(getField(step, 5))
  const createdAtMs =
    parseTimestampMs(getField(meta, 1)) ||
    parseTimestampMs(getField(meta, 6)) ||
    parseTimestampMs(getField(meta, 8)) ||
    0
  const toolSummary = getStr(meta, 30) || undefined
  const toolAction = getStr(meta, 31) || undefined
  const toolCall = asArr(getField(meta, 4))
  const toolCallName = getStr(toolCall, 2) || getStr(toolCall, 1) || undefined

  const parsed: AntigravityParsedStep = {
    index,
    type,
    status,
    createdAtMs,
    toolSummary,
    toolAction
  }

  // Field 19: UserInput
  const userInput = asArr(getField(step, 19))
  if (userInput) {
    const text =
      getStr(userInput, 2).trim() ||
      getStr(userInput, 1).trim() ||
      extractItemsText(getField(userInput, 3))
    if (text) parsed.userText = text
    const clientMessageId = getStr(userInput, 19)
    if (clientMessageId) parsed.clientMessageId = clientMessageId
  }

  // Field 20: PlannerResponse
  const planner = asArr(getField(step, 20))
  if (planner) {
    const response = (getStr(planner, 8) || getStr(planner, 1)).trim()
    if (response) parsed.assistantText = response
    const thinking = (getStr(planner, 3) || getStr(planner, 16)).trim()
    if (thinking) parsed.thinkingText = thinking
    const msgId = getStr(planner, 6) || getStr(planner, 15)
    if (msgId) parsed.messageId = msgId
  }

  // Field 94: NotifyUser
  const notify = asArr(getField(step, 94))
  if (notify) {
    const content = getStr(notify, 2).trim()
    if (content) parsed.notifyText = content
  }

  // Field 24: ErrorMessage
  const errMsg = asArr(getField(step, 24))
  if (errMsg) {
    const errInner = asArr(getField(errMsg, 3))
    const text = (getStr(errInner, 1) || getStr(errInner, 9)).trim()
    if (text) parsed.errorText = text
  }

  // Tool name when not a pure user/planner/notify/error step
  if (
    type !== CORTEX_STEP_TYPE.USER_INPUT &&
    type !== CORTEX_STEP_TYPE.PLANNER_RESPONSE &&
    type !== CORTEX_STEP_TYPE.NOTIFY_USER &&
    type !== CORTEX_STEP_TYPE.ERROR_MESSAGE &&
    (toolSummary || toolAction || toolCallName)
  ) {
    parsed.toolName = toolCallName || stepTypeFallbackName(type)
  }

  return parsed
}

/**
 * Parse `AgentStateUpdate` (`sI`) from either `GetConversationResponse` (field 2)
 * or `StreamAgentStateUpdatesResponse` (field 1).
 */
export function parseAgentStateUpdate(
  rawUpdate: unknown,
  resumeToken?: string
): AntigravityStateUpdate | null {
  const upd = asArr(rawUpdate)
  if (!upd) return null
  const conversationId = getStr(upd, 1)
  const trajectoryId = getStr(upd, 2)
  const runStatus = getNum(upd, 3)
  const mainTraj = asArr(getField(upd, 7))
  const trajStatus = getNum(mainTraj, 6)
  const fullyIdle = getBool(upd, 18) || getBool(mainTraj, 10)
  const stepsUpdate = asArr(getField(mainTraj, 1))
  const indicesRaw = asArr(getField(stepsUpdate, 1)) ?? []
  const stepsRaw = asArr(getField(stepsUpdate, 2)) ?? []
  const totalSteps = getNum(stepsUpdate, 3) || stepsRaw.length

  const steps: AntigravityParsedStep[] = []
  for (let i = 0; i < stepsRaw.length; i++) {
    const idxVal = indicesRaw[i]
    const stepIndex = typeof idxVal === 'number' && Number.isFinite(idxVal) ? idxVal : i
    const parsed = parseCortexStep(stepsRaw[i], stepIndex)
    if (parsed) steps.push(parsed)
  }

  const waitingRaw = asArr(getField(mainTraj, 9)) ?? []
  const waitingStepIndices: number[] = []
  for (const w of waitingRaw) {
    const wa = asArr(w)
    if (!wa) continue
    waitingStepIndices.push(getNum(wa, 2))
  }

  return {
    conversationId,
    trajectoryId,
    runStatus: runStatus || trajStatus,
    fullyIdle,
    resumeToken: resumeToken || undefined,
    totalSteps,
    steps,
    waitingStepIndices
  }
}

export function parseGetConversationResponse(raw: unknown): AntigravityStateUpdate | null {
  const root = asArr(raw)
  if (!root) return null
  const update = parseAgentStateUpdate(getField(root, 2), getStr(root, 4))
  if (update && !update.conversationId) {
    update.conversationId = getStr(root, 1)
  }
  return update
}

export function parseStreamUpdateResponse(raw: unknown): AntigravityStateUpdate | null {
  const root = asArr(raw)
  if (!root) return null
  return parseAgentStateUpdate(getField(root, 1), getStr(root, 2))
}

export function mergeTrajectorySteps(
  acc: Map<number, AntigravityParsedStep>,
  update: AntigravityStateUpdate
): void {
  for (const step of update.steps) {
    const previous = acc.get(step.index)
    acc.set(step.index, previous?.type === step.type && previous.clientMessageId && !step.clientMessageId
      ? { ...step, clientMessageId: previous.clientMessageId }
      : step)
  }
}

function mapStepToolStatus(status: number): 'running' | 'completed' | 'errored' {
  if (status === CORTEX_STEP_STATUS.ERROR || status === CORTEX_STEP_STATUS.CANCELED) return 'errored'
  if (
    status === CORTEX_STEP_STATUS.DONE ||
    status === CORTEX_STEP_STATUS.CLEARED ||
    status === CORTEX_STEP_STATUS.INVALID
  ) {
    return 'completed'
  }
  return 'running'
}

/**
 * Convert an Antigravity step map into BotArk chat turns (`user` and `assistant` messages).
 */
export function extractTranscriptFromSteps(
  stepsMap: ReadonlyMap<number, AntigravityParsedStep>,
  conversationId: string
): AntigravityTranscriptMessage[] {
  const ordered = [...stepsMap.values()].sort((a, b) => a.index - b.index)
  const messages: AntigravityTranscriptMessage[] = []

  let currentAssistant: {
    id: string
    parts: string[]
    tools: NonNullable<AntigravityTranscriptMessage['tools']>
    createdAt: number
  } | null = null

  const flushAssistant = () => {
    if (!currentAssistant) return
    const text = currentAssistant.parts.join('\n\n').trim()
    if (text || currentAssistant.tools.length > 0) {
      messages.push({
        id: currentAssistant.id,
        role: 'assistant',
        text,
        createdAt: currentAssistant.createdAt || Date.now(),
        tools: currentAssistant.tools.length > 0 ? currentAssistant.tools : undefined
      })
    }
    currentAssistant = null
  }

  for (const step of ordered) {
    if (step.type === CORTEX_STEP_TYPE.USER_INPUT || step.userText) {
      flushAssistant()
      if (step.userText) {
        messages.push({
          id: step.clientMessageId || `agy_${conversationId}_u_${step.index}`,
          role: 'user',
          text: step.userText,
          createdAt: step.createdAtMs || Date.now()
        })
      }
      continue
    }

    const ensureAssistant = () => {
      if (!currentAssistant) {
        currentAssistant = {
          id: step.messageId || `agy_${conversationId}_a_${step.index}`,
          parts: [],
          tools: [],
          createdAt: step.createdAtMs || Date.now()
        }
      }
      return currentAssistant
    }

    if (step.assistantText) {
      const a = ensureAssistant()
      if (a.parts[a.parts.length - 1] !== step.assistantText) {
        a.parts.push(step.assistantText)
      }
    }
    if (step.notifyText) {
      const a = ensureAssistant()
      if (a.parts[a.parts.length - 1] !== step.notifyText) {
        a.parts.push(step.notifyText)
      }
    }
    if (step.errorText) {
      const a = ensureAssistant()
      const formatted = `> ${step.errorText}`
      if (a.parts[a.parts.length - 1] !== formatted) {
        a.parts.push(formatted)
      }
    }
    if (step.toolName) {
      const a = ensureAssistant()
      a.tools.push({
        id: `agy_tool_${step.index}`,
        name: step.toolSummary || step.toolAction || step.toolName,
        status: mapStepToolStatus(step.status),
        detail: step.toolAction && step.toolAction !== step.toolSummary ? step.toolAction : undefined
      })
    }
  }

  flushAssistant()
  return messages
}

/**
 * Extract the live assistant reply text, tool badges, and current activity label
 * for all steps strictly after `afterStepIndex` (the latest user turn).
 */
export function extractTurnProgress(
  stepsMap: ReadonlyMap<number, AntigravityParsedStep>,
  afterStepIndex: number,
  beforeStepIndex = Infinity
): {
  text: string
  tools: NonNullable<AntigravityTranscriptMessage['tools']>
  activityText: string | null
  hasError: boolean
} {
  const ordered = [...stepsMap.values()]
    .filter((s) => s.index > afterStepIndex && s.index < beforeStepIndex)
    .sort((a, b) => a.index - b.index)

  const parts: string[] = []
  const tools: NonNullable<AntigravityTranscriptMessage['tools']> = []
  let activityText: string | null = null
  let hasError = false

  for (const step of ordered) {
    if (step.assistantText && parts[parts.length - 1] !== step.assistantText) {
      parts.push(step.assistantText)
    }
    if (step.notifyText && parts[parts.length - 1] !== step.notifyText) {
      parts.push(step.notifyText)
    }
    if (step.errorText) {
      hasError = true
      const formatted = `> ${step.errorText}`
      if (parts[parts.length - 1] !== formatted) parts.push(formatted)
    }
    if (step.toolName) {
      const toolStatus = mapStepToolStatus(step.status)
      const label = step.toolSummary || step.toolAction || step.toolName
      tools.push({
        id: `agy_tool_${step.index}`,
        name: label,
        status: toolStatus,
        detail: step.toolAction && step.toolAction !== label ? step.toolAction : undefined
      })
      if (toolStatus === 'running') activityText = label
    }
    if (
      step.status === CORTEX_STEP_STATUS.GENERATING ||
      step.status === CORTEX_STEP_STATUS.RUNNING
    ) {
      if (step.thinkingText && !activityText) activityText = 'Thinking…'
    }
  }

  return {
    text: parts.join('\n\n').trim(),
    tools,
    activityText,
    hasError
  }
}

export function findAntigravityTurn(
  steps: ReadonlyMap<number, AntigravityParsedStep>,
  clientMessageId: string
): { userStepIndex: number; nextUserStepIndex: number } | undefined {
  let userStepIndex: number | undefined
  for (const step of steps.values()) {
    if (step.clientMessageId === clientMessageId && step.type === CORTEX_STEP_TYPE.USER_INPUT) {
      userStepIndex = step.index
      break
    }
  }
  if (userStepIndex === undefined) return undefined
  let nextUserStepIndex = Infinity
  for (const step of steps.values()) {
    if (step.index > userStepIndex && step.type === CORTEX_STEP_TYPE.USER_INPUT) {
      nextUserStepIndex = Math.min(nextUserStepIndex, step.index)
    }
  }
  return { userStepIndex, nextUserStepIndex }
}

export type StreamBodyEvent =
  | { kind: 'message'; payload: unknown }
  | { kind: 'status'; code: number; message: string }

/**
 * Incremental parser for Google `application/json+protobuf` StreamBody responses:
 *   `[[ msg1, msg2, ... ], [ statusCode, statusMsg, ... ]]`
 *
 * Emits each `msg` as soon as its closing bracket arrives over chunked HTTP.
 */
export class JspbStreamBodyParser {
  private readonly brackets: string[] = []
  private inString = false
  private escaped = false
  private wrapper: 'before' | 'messages' | 'separator' | 'status' | 'end' | 'done' = 'before'
  private frame = ''
  private frameKind?: StreamBodyEvent['kind']

  constructor(private readonly maxFrameChars = 8 * 1024 * 1024) {}

  push(chunk: string): StreamBodyEvent[] {
    const events: StreamBodyEvent[] = []
    for (const ch of chunk) {
      if (!this.frameKind) {
        if (/\s/.test(ch)) continue
        if (this.wrapper === 'before' && ch === '[') {
          this.wrapper = 'messages'
          this.brackets.push(']')
          continue
        }
        if (this.wrapper === 'messages') {
          if (this.brackets.length === 1 && ch === '[') {
            this.brackets.push(']')
            continue
          }
          if (this.brackets.length === 2) {
            if (ch === ',') continue
            if (ch === ']') {
              this.brackets.pop()
              this.wrapper = 'separator'
              continue
            }
            if (ch === '[' || ch === '{') {
              this.frameKind = 'message'
              this.frame = ch
              this.brackets.push(ch === '[' ? ']' : '}')
              continue
            }
          }
        }
        if (this.wrapper === 'separator' && ch === ',') {
          this.wrapper = 'status'
          continue
        }
        if (this.wrapper === 'status' && ch === '[') {
          this.frameKind = 'status'
          this.frame = ch
          this.brackets.push(']')
          continue
        }
        if ((this.wrapper === 'end' || this.wrapper === 'separator') && ch === ']') {
          this.brackets.pop()
          this.wrapper = 'done'
          continue
        }
        throw new Error('Invalid Antigravity stream wrapper')
      }

      if (this.frame.length + ch.length > this.maxFrameChars) {
        throw new Error('Antigravity stream frame exceeds its size limit')
      }
      this.frame += ch
      if (this.inString) {
        if (this.escaped) this.escaped = false
        else if (ch === '\\') this.escaped = true
        else if (ch === '"') this.inString = false
        continue
      }
      if (ch === '"') this.inString = true
      else if (ch === '[' || ch === '{') this.brackets.push(ch === '[' ? ']' : '}')
      else if (ch === ']' || ch === '}') {
        if (this.brackets.pop() !== ch) throw new Error('Unbalanced Antigravity stream frame')
        const frameDepth = this.frameKind === 'message' ? 2 : 1
        if (this.brackets.length !== frameDepth) continue

        const payload = JSON.parse(this.frame)
        if (this.frameKind === 'message') {
          events.push({ kind: 'message', payload })
        } else {
          const [code = 0, message = ''] = payload as unknown[]
          if (typeof code !== 'number') throw new Error('Invalid Antigravity stream status')
          events.push({ kind: 'status', code, message: typeof message === 'string' ? message : '' })
          this.wrapper = 'end'
        }
        this.frameKind = undefined
        this.frame = ''
      }
    }
    return events
  }

  finish(): void {
    if (this.wrapper !== 'done' || this.brackets.length || this.frameKind || this.inString) {
      throw new Error('Truncated Antigravity stream response')
    }
  }
}
