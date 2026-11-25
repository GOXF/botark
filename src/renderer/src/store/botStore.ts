import { create } from 'zustand'
import { persist, type PersistStorage } from 'zustand/middleware'
import { shallow } from 'zustand/shallow'
import { getPlatform } from '@adapters/platforms'
import { adapterRegistry } from '@adapters/registry'
import { AdapterError, type AttachmentMeta, type ConnectionStatus, type IncomingMessage, type PlatformId, type SendReceipt } from '@adapters/types'
import { createId } from '@shared/id'
import { HARK_DRAFT_SESSION } from '@shared/harkProjects'
import type { MobileSendCommand, MobileSendResult } from '@shared/mobileSync'
import { createSeed } from '@/data/seed'
import { t } from '@/lib/i18n'
import type { AccountDraft, Bot, BotAccount, BotGroup, ChatMessage, ChatReplyTarget, NewBotInput } from '@/types'
import type { MuseProxyPoolItemView } from '@shared/ipc'
import { keepActivity } from './goxfActivity'
import { canReloadHistory, hasUnsettledDelivery, trimMessages, TRIM_IDLE_AFTER_MS } from './messageTrim'
import { usePrefsStore } from './prefsStore'
import { comparableText, splitLeadingQuote } from '../lib/quoteText'
import { getEventBot } from '@/services/sessionEvents'
import {
  ATTACHMENTS_LOST_TEXT, clearNoReplyFlag, createDeliveryAttempts, createSafeStorage, deliveryAfterError,
  hasLostAttachments, sanitizePersisted, SEND_HARD_TIMEOUT_MS, SEND_STILL_PENDING_TEXT, SEND_TIMEOUT_TEXT,
  SendTimeoutError, toPersistedMessages, withTimeout
} from './delivery'
import { markStalledReply, replyWatchdog } from './replyWatchdog'

let sourceAccounts: BotHubState['accounts'] | undefined
let persistedAccounts: BotHubState['accounts'] = {}

function partializeWorkspace(state: BotHubState) {
  if (sourceAccounts !== state.accounts) {
    sourceAccounts = state.accounts
    const accounts = Object.fromEntries(Object.entries(state.accounts).map(([id, account]) => {
      const { pending: _pending, ...saved } = account
      const previous = persistedAccounts[id]
      return [id, previous && shallow(previous, saved) ? previous : saved]
    }))
    if (!shallow(persistedAccounts, accounts)) persistedAccounts = accounts
  }
  return {
    groups: state.groups,
    bots: state.bots,
    accounts: persistedAccounts,
    messages: state.messages,
    selectedBotId: state.selectedBotId,
    collapsedGroups: state.collapsedGroups,
    dismissedGrokAgents: state.dismissedGrokAgents,
    trimmedBots: state.trimmedBots,
    webSessionByBot: state.webSessionByBot,
    infoPanelOpen: state.infoPanelOpen,
    sidebarCollapsed: state.sidebarCollapsed,
    sidebarWidth: state.sidebarWidth
  }
}

type WorkspaceSnapshot = ReturnType<typeof partializeWorkspace>
let lastWorkspace: WorkspaceSnapshot | undefined
let warnedStorage = false
const workspaceBacking = createSafeStorage(
  () => (typeof localStorage === 'undefined' ? undefined : localStorage),
  (error) => {
    lastWorkspace = undefined
    if (warnedStorage) return
    warnedStorage = true
    console.warn('[bothub] could not save workspace:', error instanceof Error ? error.name : 'error')
  },
  { debounceMs: 350 }
)
const workspaceStorage: PersistStorage<WorkspaceSnapshot> = {
  getItem(name) {
    const saved = workspaceBacking.getItem(name)
    return saved ? JSON.parse(saved) : null
  },
  setItem(name, value) {
    if (lastWorkspace && shallow(lastWorkspace, value.state)) return
    const state = value.state
    lastWorkspace = state
    workspaceBacking.setItem(name, () => JSON.stringify({
      ...value,
      state: { ...state, messages: toPersistedMessages(state.messages) }
    }))
  },
  removeItem(name) {
    lastWorkspace = undefined
    workspaceBacking.removeItem(name)
  }
}

export const flushWorkspacePersistence = workspaceBacking.flush

if (typeof window !== 'undefined') {
  window.addEventListener?.('beforeunload', flushWorkspacePersistence)
  window.addEventListener?.('pagehide', flushWorkspacePersistence)
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', flushWorkspacePersistence)

const NO_REPLY_TEXT = '已送达，但没有收到回复'
/** Replies that appeared through stream deltas and have not had their final message yet (unread counts there). */

function electronBridge() {
  if (typeof window === 'undefined') return undefined
  return window.electron
}

export interface BotHubState {
  groups: BotGroup[]
  bots: Bot[]
  accounts: Record<string, BotAccount>
  /** Conversation per bot, keyed by bot id. */
  messages: Record<string, ChatMessage[]>
  /** Bot ids whose reply is currently being generated. */
  typing: Record<string, boolean>
  /** Per-account Muse agent.status phrase. */
  activity: Record<string, import('@/types').BotActivity>
  selectedBotId: string | null
  collapsedGroups: Record<string, boolean>
  infoPanelOpen: boolean
  /** Sidebar collapsed into compact icon rail (Grok Bot style). */
  sidebarCollapsed: boolean
  /** Sidebar width in px (dragged by its right edge). */
  sidebarWidth: number
  addBotOpen: boolean
  /** Optional platform pre-highlighted when opening AddBotDialog from Onboarding. */
  addBotInitialPlatform: PlatformId | null
  /** Bumped on every open so each add-bot flow starts fresh. */
  addBotKey: number
  /** Interactive product & security onboarding tour modal. */
  onboardingOpen: boolean
  /** Command palette (⌘K); `paletteQuery` seeds it when typing opens it. */
  paletteOpen: boolean
  paletteQuery: string
  paletteKey: number
  /** Show the embedded platform web session instead of the chat (Electron only). */
  webSessionOpen: boolean
  /** Per-bot remembered WebSession view choice so switching bots and switching back keeps the user's chosen view. */
  webSessionByBot: Record<string, boolean>
  /** Optional deep-link URL to open inside the embedded platform web session. */
  webSessionTargetUrl: string | null
  /** Open the dedicated Grok Bot-style Settings view in the main pane. */
  settingsOpen: boolean
  settingsTab:
    | 'overview'
    | 'general'
    | 'muse-accounts'
    | 'dot-accounts'
    | 'grok-accounts'
    | 'hark-accounts'
    | 'hermes-accounts'
    | 'antigravity-accounts'
    | 'cue-accounts'
    | 'mcp-hub'
    | 'mobile-sync'
    | 'proxy-pool'
  /** Active document/article opened in the right-side Split-Pane Document Canvas. */
  activeDocument: import('@/components/chat/NativeDocumentDialog').NativeDocumentTarget | null
  /** Per-bot pending quote-reply target shown in Composer. */
  replyingTo: Record<string, ChatReplyTarget | undefined>
  hermesSessionErrors: Record<string, string | undefined>
  chatActionErrors: Record<string, string | undefined>
  /** Per-account Grok agentIds explicitly removed from sidebar so auto-sync respects user deletion until manual sync. */
  dismissedGrokAgents: Record<string, string[]>
  /** Bots whose displayed list was cut while idle; their history reloads on next open. */
  trimmedBots: Record<string, true>

  // Navigation & layout
  selectBot: (botId: string) => void
  setActiveDocument: (doc: import('@/components/chat/NativeDocumentDialog').NativeDocumentTarget | null) => void
  setReplyTarget: (botId: string, target: ChatReplyTarget | null) => void
  deleteMessages: (botId: string, messageIds: string[]) => void
  toggleGroup: (groupId: string) => void
  /** Create a local sidebar section (Grok-like; not a host API). */
  addGroup: (name?: string) => string
  renameGroup: (groupId: string, name: string) => void
  /** Drop a section; its bots move to another section. Keeps at least one. */
  removeGroup: (groupId: string) => void
  moveBotToGroup: (botId: string, groupId: string) => void
  togglePinBot: (botId: string) => void
  /** Local drag-reorder: place `botId` before `beforeId` (or at end) inside `groupId`. */
  reorderBot: (botId: string, groupId: string, beforeId: string | null) => void
  toggleInfoPanel: () => void
  toggleSidebarCollapsed: () => void
  setSidebarWidth: (width: number) => void
  setAddBotOpen: (open: boolean, initialPlatform?: PlatformId | null) => void
  setOnboardingOpen: (open: boolean) => void
  toggleWebSession: () => void
  openWebSessionAt: (url?: string | null) => void
  closeWebSession: () => void
  setSettingsOpen: (
    open: boolean,
    tab?:
      | 'overview'
      | 'general'
      | 'muse-accounts'
      | 'dot-accounts'
      | 'grok-accounts'
      | 'hark-accounts'
      | 'hermes-accounts'
      | 'antigravity-accounts'
      | 'cue-accounts'
      | 'mcp-hub'
      | 'mobile-sync'
      | 'proxy-pool'
  ) => void
  openPalette: (query?: string) => void
  closePalette: () => void
  /** Select the bot `offset` rows away in sidebar order (wraps). */
  selectAdjacentBot: (offset: number) => void

  // Creation
  /** Create a bot (and any new accounts/group), select it, and connect its accounts. */
  addBot: (input: NewBotInput) => string
  addAccountsToBot: (botId: string, drafts: AccountDraft[]) => void
  renameBot: (botId: string, name: string) => void
  setBotAvatar: (botId: string, avatar: string | undefined) => void
  setBotCharacter: (botId: string, character: { shape?: string; color?: string }) => void
  /** Delete a bot; accounts no other bot uses are signed out and dropped. */
  removeBot: (botId: string) => Promise<void>

  // Conversation
  sendMessage: (botId: string, text: string, attachments?: AttachmentMeta[]) => Promise<void>
  queueMobileMessage: (command: MobileSendCommand) => MobileSendResult
  retryMessage: (botId: string, messageId: string) => Promise<void>
  receiveMessage: (message: IncomingMessage) => void
  /** Upsert a streaming assistant bubble (same id updated as deltas arrive). */
  applyMessageDelta: (messageId: string, conversationId: string, accountId: string, text: string, widgets?: import('@/types').ChatOptionWidget[], tools?: import('@/types').ChatToolCall[], media?: import('@/types').ChatMediaPart[], richWidgets?: import('@/types').ChatRichWidget[]) => void
  setTyping: (botId: string, isTyping: boolean) => void
  finishReply: (botId: string, stalled?: boolean) => void
  setActivity: (accountId: string, activity: import('@/types').BotActivity | null) => void
  setMessageWidgets: (botId: string, messageId: string, widgets: import('@/types').ChatOptionWidget[]) => void
  selectChatOption: (botId: string, messageId: string, widgetId: string, selectedText: string, optionIndex: number) => Promise<void>
  cancelGeneration: (botId: string) => Promise<void>
  switchMuseSession: (botId: string, sessionId: string) => Promise<void>
  startNewMuseSession: (botId: string) => Promise<void>
  startNewGrokSession: (botId: string) => Promise<void>
  applyHarkHistory: (botId: string, accountId: string, sessionId: string, messages: unknown[]) => void
  switchHarkSession: (botId: string, sessionId: string) => Promise<void>
  /** Resolves to the new Hark conversation id (undefined if the bot is gone). */
  startNewHarkSession: (botId: string, title: string) => Promise<string | undefined>
  /** Open an empty Hark draft project; it is created on Hark when its first message is sent. */
  startHarkDraft: (botId: string) => void
  switchHermesSession: (botId: string, sessionId: string) => Promise<void>
  startNewHermesSession: (botId: string) => Promise<boolean>
  switchAntigravitySession: (botId: string, sessionId: string) => Promise<void>
  startNewAntigravitySession: (botId: string) => void
  /** GOXF Issue #7: read one conversation of a multi-conversation bot without switching to it. */
  loadConversation: (botId: string, conversationId: string) => Promise<ChatMessage[] | undefined>
  /** GOXF Issue #7: make a conversation the bot's active one, whatever the platform. */
  switchConversation: (botId: string, conversationId: string) => Promise<void>

  // Bot details
  updateNotes: (botId: string, notes: string) => void
  addMemory: (botId: string, text: string) => void
  removeMemory: (botId: string, memoryId: string) => void

  // Accounts
  removeAccountFromBot: (botId: string, accountId: string) => void
  setActiveAccount: (botId: string, accountId: string) => void
  setSelectedAgent: (botId: string, agentId: string) => void
  renameAccount: (accountId: string, displayName: string) => void
  /** Sign out: clear persist partition + mark offline. */
  signOutAccount: (accountId: string) => Promise<void>
  /** Remove from bot and wipe the partition (full delete). */
  removeAndClearAccount: (botId: string, accountId: string) => Promise<void>
  /** Sign out and remove an account that no longer belongs to any bot. */
  removeOrphanedAccount: (accountId: string) => Promise<void>
  setAccountStatus: (accountId: string, status: ConnectionStatus, detail?: string) => void
  connectAccount: (accountId: string) => Promise<void>
  /** Muse: open same-partition login BrowserWindow. */
  openMuseLogin: (accountId: string) => Promise<void>
  /** Grok: open PKCE login (embedded window by default, or OS browser when `openInBrowser` is true). */
  openGrokLogin: (accountId: string, openInBrowser?: boolean) => Promise<void>
  /** Sync all Agents under a Grok account so each Agent appears as its own Bot in the left sidebar. */
  syncGrokAccountBots: (
    accountId: string,
    opts?: { includeDismissed?: boolean; selectFirst?: boolean; preferredGroupId?: string }
  ) => Promise<number>
  /** Hark: open Hark login window (Google / Apple / Email OTP). */
  openHarkLogin: (accountId: string) => Promise<void>
  /** Dot: open ChatGPT Dot login window (chatgpt.com/dots). */
  openDotLogin: (accountId: string) => Promise<void>
  /** Antigravity: open Google Antigravity login window (antigravity.google.com). */
  openAntigravityLogin: (accountId: string) => Promise<void>
  /** Cue: open Cue login window (or system browser when `openInBrowser` is true). */
  openCueLogin: (accountId: string, openInBrowser?: boolean) => Promise<void>
  /** Cue: import Cue/Manus credentials (Bearer JWT, API key, Cookie, or JSON) and sync bots. */
  importCueCredentials: (accountId: string, credential: string) => Promise<void>
  /** Sync all Agents under a Cue account so each account/agent gets a distinct sidebar Bot. */
  syncCueAccountBots: (
    accountId: string,
    opts?: { selectFirst?: boolean; preferredGroupId?: string }
  ) => Promise<number>
  /** Hydrate full Cue session history (older turns + latest messages) for a Cue bot. */
  hydrateCueBotHistory: (botId: string) => Promise<number>
  /** Drop old display copies of bots not viewed for a while and not working (renderer memory only). */
  trimIdleBots: (now?: number) => void
  /** Inject Grok accessToken (or mark main-captured PKCE session active) in adapter. */
  setGrokAccessToken: (
    accountId: string,
    accessToken?: string,
    accountSlot?: string,
    machineId?: string,
    refreshToken?: string
  ) => Promise<void>
  disconnectAccount: (accountId: string) => Promise<void>
  /** Wipe all stored credentials, tokens, cookies, and proxy pool across all platforms. */
  clearAllCredentials: () => Promise<void>
  /** Wipe all credentials and reset workspace (bots, accounts, messages, groups) to factory defaults. */
  resetWorkspace: () => Promise<void>
}


function uniqueGroupName(groups: BotGroup[], base = 'New section'): string {
  const taken = new Set(groups.map((g) => g.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

export function uniqueBotName(bots: ReadonlyArray<{ name: string }>, baseName: string): string {
  const base = baseName.trim() || 'Bot'
  const taken = new Set(bots.map((b) => b.name.trim().toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

const seed = createSeed()

export const SIDEBAR_MIN = 240
export const SIDEBAR_MAX = 400
export const SIDEBAR_DEFAULT = 280

/** Turn form drafts into account ids, creating BotAccounts for new ones. */
function materializeAccounts(
  platformId: PlatformId,
  drafts: AccountDraft[],
  existing: Record<string, BotAccount>
): { ids: string[]; created: Record<string, BotAccount> } {
  const ids: string[] = []
  const created: Record<string, BotAccount> = {}
  for (const draft of drafts) {
    const displayName = draft.displayName.trim() || draft.handle.trim()
    // Keep drafts that already have a partition account id even if the name is empty.
    if (!displayName && !draft.accountId) continue
    if (draft.accountId && existing[draft.accountId]) {
      if (!ids.includes(draft.accountId)) ids.push(draft.accountId)
      continue
    }
    const id = draft.accountId ?? createId('acc')
    created[id] = {
      id,
      platformId,
      displayName: displayName || getPlatform(platformId).name,
      handle: draft.handle.trim(),
      status: 'offline',
      ...(draft.importKey ? { importKey: draft.importKey } : {})
    }
    ids.push(id)
  }
  return { ids, created }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const { [key]: _removed, ...rest } = record
  return rest
}

function prevMediaMerge(
  prev: import('@/types').ChatMediaPart[] | undefined,
  incoming: import('@/types').ChatMediaPart[] | undefined
): import('@/types').ChatMediaPart[] | undefined {
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

function normalizeDotMsgId(rawId: string, role: 'user' | 'bot'): string {
  const clean = rawId.replace(/^(dot_u_|dot_)+/, '')
  return role === 'user' ? `dot_u_${clean}` : `dot_${clean}`
}

function isOmittedPlaceholderText(text: string): boolean {
  return text.startsWith('[消息内容较大') || text.startsWith('[Message body omitted')
}

/** Text or pictures: a picture-only message still has to match its server copy (else it shows twice). */
function hasBody(m: ChatMessage): boolean {
  return Boolean(m.text || m.attachments?.length || m.media?.length)
}

function mergeHydratedMessages(
  existing: ChatMessage[],
  hydrated: ChatMessage[],
  beforeRequest?: ChatMessage[]
): ChatMessage[] {
  if (hydrated.length === 0) return existing
  const { accountId, agentId } = hydrated[0]!
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
    if (hasBody(localMsg) && localMsg.delivery !== 'failed' && (live || (localMsg.role === 'user' &&
        (localMsg.id.startsWith('msg_') || localMsg.id.startsWith('opt_'))))) {
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
    const delivering = local.delivery === 'sending' || local.delivery === 'accepted' ||
      local.error === SEND_STILL_PENDING_TEXT
    return {
      ...local,
      ...remote,
      id: delivering || live ? local.id : remote.id,
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

/**
 * `assignProxyPool(accountIds, keepIds)` arguments: targets are `targetIds`
 * (default: every account) on the ticked `platforms`; every other known account
 * — including `pending` ones not in the store yet — is kept so its binding survives.
 */
export function proxyPoolArgs(
  accounts: Record<string, { id: string; platformId: string }>,
  platforms: readonly string[],
  targetIds?: readonly string[],
  pending: ReadonlyArray<{ id: string; platformId: string }> = []
): { accountIds: string[]; keepIds: string[] } {
  const all = [...Object.values(accounts), ...pending]
  const wanted = targetIds && new Set(targetIds)
  const targets = new Set(
    all.filter((a) => (!wanted || wanted.has(a.id)) && platforms.includes(a.platformId)).map((a) => a.id)
  )
  return { accountIds: [...targets], keepIds: [...new Set(all.map((a) => a.id))].filter((id) => !targets.has(id)) }
}

/** Auto-assign pool proxies per the pool settings (ticked platforms, per-proxy limit). */
export async function autoAssignProxyPool(
  targetIds?: readonly string[],
  pending: ReadonlyArray<{ id: string; platformId: string }> = []
): Promise<{ assignedCount: number; items: MuseProxyPoolItemView[] } | undefined> {
  const assign = electronBridge()?.muse?.assignProxyPool
  if (!assign) return undefined
  const { proxyAssignPlatforms, proxyPerProxyLimit } = usePrefsStore.getState()
  const { accountIds, keepIds } = proxyPoolArgs(useBotStore.getState().accounts, proxyAssignPlatforms, targetIds, pending)
  if (accountIds.length === 0) return undefined
  return assign(accountIds, keepIds, proxyPerProxyLimit)
}

export async function cancelPlatformTurn(bot: Bot) {
  const bridge = electronBridge()
  if (bot.platformId === 'meta-muse' && bridge?.muse?.cancelChat) {
    await bridge.muse.cancelChat(bot.activeAccountId, bot.activeSessionId)
  } else if (bot.platformId === 'grok' && bot.selectedAgentId && bridge?.grok?.rpc) {
    await bridge.grok
      .rpc({
        accountId: bot.activeAccountId,
        op: 'call',
        method: 'InterruptGrokBotAgentRun',
        params: {
          agent_id: bot.selectedAgentId,
          reason: 'user_interrupt',
          ...(bot.activeSessionId ? { session_id: bot.activeSessionId } : {})
        }
      })
      .catch(() => undefined)
  } else if (bot.platformId === 'hark' && bridge?.hark?.rpc) {
    await Promise.all([
      bridge.hark
        .rpc({
          accountId: bot.activeAccountId,
          op: 'call',
          method: 'POST',
          path: '/messages/pause-agent',
          body: bot.activeSessionId ? { conversationId: bot.activeSessionId } : {}
        })
        .catch(() => undefined),
      bridge.hark
        .rpc({
          accountId: bot.activeAccountId,
          op: 'call',
          method: 'POST',
          path: '/messages/stop-tool',
          body: bot.activeSessionId ? { conversationId: bot.activeSessionId } : {}
        })
        .catch(() => undefined)
    ])
  } else if (bot.platformId === 'dot' && bridge?.dot?.rpc) {
    await bridge.dot
      .rpc({
        accountId: bot.activeAccountId,
        op: 'cancelTurn'
      })
      .catch(() => undefined)
  } else if (bot.platformId === 'hermes' && bridge?.hermes?.rpc) {
    const res = await bridge.hermes.rpc({
      accountId: bot.activeAccountId,
      op: 'stopRun'
    })
    if (res && res.ok === false) {
      throw new Error(res.message || '未能确认停止 Hermes 运行')
    }
  } else if (bot.platformId === 'antigravity' && bridge?.antigravity?.cancelRun) {
    await bridge.antigravity.cancelRun(bot.activeAccountId).catch(() => undefined)
  }
}

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

export const useBotStore = create<BotHubState>()(
  persist((set, get) => {
  const updateMessage = (botId: string, messageId: string, patch: Partial<ChatMessage>) =>
    set((state) => {
      const list = state.messages[botId]
      if (!list?.some((m) => m.id === messageId)) return state
      return {
        messages: { ...state.messages, [botId]: list.map((m) => (m.id === messageId ? { ...m, ...patch } : m)) }
      }
    })

  const patchBot = (botId: string, patch: (bot: Bot) => Partial<Bot>) =>
    set((state) => ({ bots: state.bots.map((b) => (b.id === botId ? { ...b, ...patch(b) } : b)) }))

  // An account or session can be selected again while an earlier request for it is still pending.
  const sessionSelections = new Map<string, symbol>()
  const markSessionSelection = (botId: string) => {
    const selection = Symbol()
    sessionSelections.set(botId, selection)
    return selection
  }
  const isCurrentSession = (bot: Bot, selection: symbol | undefined): boolean => {
    if (sessionSelections.get(bot.id) !== selection) return false
    const current = get().bots.find((b) => b.id === bot.id)
    return Boolean(current && current.activeAccountId === bot.activeAccountId && current.selectedAgentId === bot.selectedAgentId &&
      current.activeSessionId === bot.activeSessionId &&
      current.hermesSessionKey === bot.hermesSessionKey)
  }
  // Keep the previous transcript visible during a manual history load. The
  // baseline identifies which messages are from that transcript at commit.
  const transcriptTransitions = new Map<string, { sessionId: string; previous: ChatMessage[] }>()
  const finalizedReplies = new WeakSet<ChatMessage>()
  const accountGenerations = new Map<string, symbol>()
  const cueRosterGenerations = new Map<string, symbol>()
  const accountConnections = new Map<string, { transport?: Promise<ConnectionStatus> }>()
  const cueCredentialImports = new Map<string, Promise<unknown>>()
  const accountCleanup = new Map<string, Promise<void>>()
  let workspaceGeneration = Symbol()
  let credentialCleanup: Promise<void> | undefined
  const invalidateAccount = (id: string) => accountGenerations.set(id, Symbol())
  const watchAccount = (id: string) => {
    const generation = accountGenerations.get(id)
    const workspace = workspaceGeneration
    return () => accountGenerations.get(id) === generation && workspaceGeneration === workspace
  }

  const invalidateCueRoster = (bot: Bot, accountIds: string[]) => {
    if (bot.platformId !== 'cue') return
    for (const accountId of accountIds) cueRosterGenerations.set(accountId, Symbol())
  }

  const applyAccountLive = (
    accountsMap: Record<string, BotAccount>,
    accountId: string,
    phase: 'online' | 'busy',
    onlyFrom?: ReadonlyArray<ConnectionStatus>
  ): Record<string, BotAccount> => {
    const acc = accountsMap[accountId]
    if (!acc) return accountsMap
    if (acc.status === 'attention') return accountsMap
    if (onlyFrom && !onlyFrom.includes(acc.status)) return accountsMap
    if (acc.status === phase && acc.statusDetail === undefined) return accountsMap
    return {
      ...accountsMap,
      [accountId]: { ...acc, status: phase, statusDetail: undefined }
    }
  }

  const applySettleAccountBusy = (
    accountsMap: Record<string, BotAccount>,
    activityMap: Record<string, import('@/types').BotActivity>,
    typingMap: Record<string, boolean>,
    botsList: ReadonlyArray<Bot>,
    accountId: string,
    botId?: string
  ): Record<string, BotAccount> => {
    const acc = accountsMap[accountId]
    if (!acc || acc.status !== 'busy') return accountsMap
    if (activityMap[accountId]?.busy) return accountsMap
    if (botId && typingMap[botId] === true) return accountsMap
    if (botsList.some((b) => b.activeAccountId === accountId && typingMap[b.id] === true)) {
      return accountsMap
    }
    return {
      ...accountsMap,
      [accountId]: { ...acc, status: 'online', statusDetail: undefined }
    }
  }

  const clearedTurn = (state: BotHubState, bot: Bot) => {
    replyWatchdog.forget(bot.id)
    const typing = omitKey(state.typing, bot.id)
    const accountId = bot.activeAccountId
    const otherTurn = state.bots.some((b) => b.id !== bot.id && b.activeAccountId === accountId && typing[b.id])
    const activity = otherTurn ? state.activity : omitKey(state.activity, accountId)
    const accounts = applySettleAccountBusy(state.accounts, activity, typing, state.bots, accountId)
    return { typing, activity, accounts }
  }

  const clearedSession = (state: BotHubState, bot: Bot) => ({
    ...clearedTurn(state, bot),
    replyingTo: omitKey(state.replyingTo, bot.id),
    chatActionErrors: omitKey(state.chatActionErrors, bot.id)
  })

  const withIncomingReply = (
    state: BotHubState, bot: Bot, list: ChatMessage[], isNew: boolean, accounts = state.accounts
  ) => {
    const selected = state.selectedBotId === bot.id
    const accountId = bot.activeAccountId
    const account = accounts[accountId]
    if (account && isNew) {
      const unread = selected ? 0 : (account.unread ?? 0) + 1
      if (unread !== (account.unread ?? 0)) accounts = { ...accounts, [accountId]: { ...account, unread } }
    }
    return {
      accounts,
      messages: { ...state.messages, [bot.id]: list },
      bots: isNew && !selected
        ? state.bots.map((b) => b.id === bot.id ? { ...b, unread: b.unread + 1 } : b)
        : state.bots
    }
  }

  const setFreshSession = (bot: Bot, activeSessionId: string | undefined, hermesSessionKey?: string) => {
    transcriptTransitions.delete(bot.id)
    set((state) => ({
      ...clearedSession(state, bot),
      bots: state.bots.map((b) => b.id === bot.id
        ? { ...b, activeSessionId, ...(hermesSessionKey ? { hermesSessionKey } : {}) }
        : b),
      messages: { ...state.messages, [bot.id]: [] }
    }))
  }

  const beginHistorySelection = (bot: Bot, sessionId: string) => {
    const selection = markSessionSelection(bot.id)
    const before = get().messages[bot.id] ?? []
    if (bot.activeSessionId !== sessionId) {
      transcriptTransitions.set(bot.id, { sessionId, previous: before })
      set((state) => ({
        ...clearedSession(state, bot),
        bots: state.bots.map((b) => b.id === bot.id ? { ...b, activeSessionId: sessionId } : b)
      }))
    } else {
      setChatActionError(bot.id)
    }
    return { selection, before, target: { ...bot, activeSessionId: sessionId } }
  }

  const commitHistory = (bot: Bot, selection: symbol, before: ChatMessage[], history: ChatMessage[]) => {
    set((state) => {
      if (!isCurrentSession(bot, selection)) return state
      const transition = transcriptTransitions.get(bot.id)
      const previous = transition && transition.sessionId === bot.activeSessionId
        ? new Set(transition.previous.map((m) => m.id)) : undefined
      transcriptTransitions.delete(bot.id)
      const local = (state.messages[bot.id] ?? []).filter((m) => !previous?.has(m.id))
      return {
        messages: { ...state.messages, [bot.id]: mergeHydratedMessages(local, history, before) },
        accounts: applyAccountLive(state.accounts, bot.activeAccountId, 'online', ['offline', 'error'])
      }
    })
  }

  const ensureAccountLive = (
    accountId: string,
    phase: 'online' | 'busy',
    opts?: { onlyFrom?: ReadonlyArray<ConnectionStatus> }
  ) =>
    set((state) => {
      const nextAccounts = applyAccountLive(state.accounts, accountId, phase, opts?.onlyFrom)
      return nextAccounts === state.accounts ? state : { accounts: nextAccounts }
    })

  const settleAccountBusy = (accountId: string, botId?: string) =>
    set((state) => {
      const nextAccounts = applySettleAccountBusy(
        state.accounts,
        state.activity,
        state.typing,
        state.bots,
        accountId,
        botId
      )
      return nextAccounts === state.accounts ? state : { accounts: nextAccounts }
    })

  const pendingHarkSelections = new Map<string, symbol>()
  const loadHarkSession = async (bot: Bot, sessionId: string | undefined, selection: symbol | undefined) => {
    const accountId = bot.activeAccountId
    if (sessionId === HARK_DRAFT_SESSION) return // nothing on Hark yet
    const accountIsCurrent = watchAccount(accountId)
    const isCurrent = () => accountIsCurrent() && isCurrentSession(bot, selection)
    const before = get().messages[bot.id] ?? []
    let result
    try {
      result = await electronBridge()?.hark?.rpc(sessionId
        ? { accountId, op: 'conversationSnapshot', conversationId: sessionId }
        : { accountId, op: 'mainConversation' })
    } catch (error) {
      if (isCurrent()) throw error
      return
    }
    if (!isCurrent()) return
    if (!result?.ok) throw new Error(result?.message ?? 'Hark unavailable')
    const id = (result.data as { conversationId?: string } | null)?.conversationId
    if (typeof id !== 'string' || !id.trim()) throw new Error('Hark returned no conversation ID')
    if (sessionId && sessionId !== id) throw new Error('Hark returned a different conversation')
    const history = harkHistory(result.data, bot.id, accountId)
    set((state) => {
      if (!isCurrent()) return state
      const switched = Boolean(bot.activeSessionId && bot.activeSessionId !== id)
      const turn = switched ? clearedSession(state, bot) : undefined
      return {
        ...turn,
        ...(bot.activeSessionId !== id ? { bots: state.bots.map((b) => b.id === bot.id ? { ...b, activeSessionId: id } : b) } : {}),
        messages: { ...state.messages, [bot.id]: switched ? history : mergeHydratedMessages(state.messages[bot.id] ?? [], history, before) },
        accounts: applyAccountLive(turn?.accounts ?? state.accounts, accountId, 'online', ['offline', 'error'])
      }
    })
  }

  const setHermesSessionError = (botId: string, error?: string) =>
    set((state) => ({ hermesSessionErrors: { ...state.hermesSessionErrors, [botId]: error } }))

  const setChatActionError = (botId: string, error?: string) =>
    set((state) => {
      if (state.chatActionErrors[botId] === error) return state
      return {
        chatActionErrors: error ? { ...state.chatActionErrors, [botId]: error } : omitKey(state.chatActionErrors, botId)
      }
    })

  const reportHistoryError = (bot: Bot, selection: symbol, error: unknown) => {
    if (isCurrentSession(bot, selection)) setChatActionError(bot.id, errorMessage(error))
    return undefined
  }

  const patchAccount = (accountId: string, patch: Partial<BotAccount>) =>
    set((state) => {
      const account = state.accounts[accountId]
      if (!account) return state
      const next = { ...account, ...patch }
      return shallow(account, next) ? state : { accounts: { ...state.accounts, [accountId]: next } }
    })

  const cleanupAccount = (account: BotAccount): Promise<void> => {
    const { id: accountId, platformId } = account
    const pending = accountCleanup.get(accountId)
    if (pending) return pending
    const connection = accountConnections.get(accountId)
    const credentialImport = cueCredentialImports.get(accountId)
    const job = Promise.resolve().then(async () => {
      await Promise.allSettled([connection?.transport, credentialImport])
      const bridge = electronBridge()
      const adapter = adapterRegistry.get(platformId)
      await Promise.resolve().then(() => adapter?.disconnect(accountId)).catch(() => undefined)
      try {
        if (platformId === 'meta-muse' && bridge?.muse?.signOut) {
          await bridge.muse.signOut(accountId)
        } else {
          try {
            const platformBridge = platformId === 'grok' ? bridge?.grok
              : platformId === 'dot' ? bridge?.dot
              : platformId === 'hark' ? bridge?.hark
              : platformId === 'hermes' ? bridge?.hermes
              : platformId === 'antigravity' ? bridge?.antigravity
              : platformId === 'cue' ? bridge?.cue : undefined
            await platformBridge?.clearAuth?.(accountId)
          } finally {
            if (platformId === 'grok') (adapter as { clearAuth?: (id: string) => void })?.clearAuth?.(accountId)
            if (platformId !== 'hermes') await bridge?.webViews?.clearPartition?.(accountId)
          }
        }
        patchAccount(accountId, { status: 'offline', statusDetail: 'Signed out', unread: 0 })
      } catch (error) {
        patchAccount(accountId, { statusDetail: errorMessage(error) })
      }
    }).finally(() => {
      accountCleanup.delete(accountId)
      patchAccount(accountId, { pending: false })
      flushWorkspacePersistence()
    })
    accountCleanup.set(accountId, job)
    patchAccount(accountId, { pending: true })
    return job
  }

  const cueHistoryRequests = new Map<string, symbol | undefined>()

  const hydrateCueHistoryForBot = async (accountId: string, bot: Bot): Promise<number> => {
    const bridge = electronBridge()
    if (!bridge?.cue?.rpc || accountId !== bot.activeAccountId) return 0
    const selection = sessionSelections.get(bot.id)
    const accountIsCurrent = watchAccount(accountId)
    if (!isCurrentSession(bot, selection)) return 0
    const key = JSON.stringify([bot.id, accountId, bot.selectedAgentId, bot.activeSessionId])
    if (cueHistoryRequests.has(key) && cueHistoryRequests.get(key) === selection) return 0
    cueHistoryRequests.set(key, selection)
    const before = get().messages[bot.id] ?? []
    try {
      const res = await bridge.cue
        .rpc({
          accountId,
          op: 'getHistory',
          sessionId: bot.activeSessionId,
          agentId: bot.selectedAgentId,
          limit: 300
        })
        .catch(() => null)
      if (!res?.ok || !res.data || typeof res.data !== 'object') return 0
      const dataRec = res.data as { sessionId?: unknown; messages?: unknown[] }
      const resolvedSessionId =
        typeof dataRec.sessionId === 'string' && dataRec.sessionId.trim()
          ? dataRec.sessionId.trim()
          : undefined
      if ((bot.activeSessionId && resolvedSessionId && bot.activeSessionId !== resolvedSessionId) ||
          !accountIsCurrent() || !isCurrentSession(bot, selection)) return 0
      const raw = dataRec.messages
      const hydrated: ChatMessage[] = []
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (!item || typeof item !== 'object') continue
          const m = item as Record<string, unknown>
          const id = typeof m['id'] === 'string' && m['id'] ? m['id'] : ''
          const text = typeof m['text'] === 'string' ? m['text'].trim() : ''
          const role = m['role'] === 'user' ? 'user' : m['role'] === 'bot' ? 'bot' : null
          const createdAt = typeof m['createdAtMs'] === 'number' ? m['createdAtMs'] : Date.now()
          if (!id || !text || !role) continue
          hydrated.push({
            id,
            botId: bot.id,
            accountId,
            ...(bot.selectedAgentId ? { agentId: bot.selectedAgentId } : {}),
            role,
            text,
            createdAt,
            ...(role === 'user' ? { delivery: 'sent' as const } : {})
          })
        }
      }
      if (hydrated.length > 0 || (resolvedSessionId && resolvedSessionId !== bot.activeSessionId)) {
        set((s) => ({
          ...(resolvedSessionId && resolvedSessionId !== bot.activeSessionId
            ? { bots: s.bots.map((b) => b.id === bot.id ? { ...b, activeSessionId: resolvedSessionId } : b) }
            : {}),
          messages: { ...s.messages, [bot.id]: mergeHydratedMessages(s.messages[bot.id] ?? [], hydrated, before) }
        }))
      }
      return hydrated.length
    } finally {
      if (cueHistoryRequests.get(key) === selection) cueHistoryRequests.delete(key)
    }
  }

  const attempts = createDeliveryAttempts()

  /** Hand a stored user message to the bot's platform adapter. */
  const deliver = async (botId: string, messageId: string, retry = false) => {
    const state = get()
    const bot = state.bots.find((b) => b.id === botId)
    const message = state.messages[botId]?.find((m) => m.id === messageId)
    if (!bot || !message || bot.activeAccountId !== message.accountId ||
        (message.agentId && message.agentId !== bot.selectedAgentId)) return

    const adapter = adapterRegistry.get(bot.platformId)
    if (!adapter) {
      updateMessage(botId, messageId, { delivery: 'failed', error: 'This platform is not available yet.' })
      return
    }

    const key = JSON.stringify([botId, messageId])
    const attempt = attempts.begin(key)
    if (!attempt) return
    const finish = () => attempts.finish(key, attempt)
    const accountIsCurrent = watchAccount(message.accountId)
    const isCurrent = () => attempts.isCurrent(key, attempt) && accountIsCurrent() &&
      get().messages[botId]?.some((m) => m.id === messageId && m.accountId === message.accountId)
    const selection = sessionSelections.get(botId)
    if (retry) updateMessage(botId, messageId, { delivery: 'sending', error: undefined })

    const applyReceipt = (receipt: SendReceipt) => {
      if (!isCurrent()) return
      const loading = transcriptTransitions.get(botId)
      if (receipt.sessionId && receipt.sessionId !== bot.activeSessionId && isCurrentSession(bot, selection) &&
          (!loading || loading.sessionId !== bot.activeSessionId)) {
        patchBot(botId, () => ({ activeSessionId: receipt.sessionId }))
      }
      const current = get().messages[botId]?.find((m) => m.id === messageId)
      if (current?.delivery !== 'sent') {
        updateMessage(botId, messageId, receipt.noReply
          ? { delivery: 'no-reply', error: NO_REPLY_TEXT }
          : { delivery: 'sent', error: undefined })
      }
      ensureAccountLive(message.accountId, 'online', { onlyFrom: ['offline', 'error'] })
      settleAccountBusy(message.accountId, botId)
    }

    let accepted = false
    let timedOut = false
    const onAccepted = (createdSessionId?: string) => {
      if (accepted || !isCurrent()) return
      accepted = true
      // A draft project now exists on Hark: follow it, unless the user already moved on.
      if (createdSessionId && bot.activeSessionId === HARK_DRAFT_SESSION && isCurrentSession(bot, selection)) {
        patchBot(botId, () => ({ activeSessionId: createdSessionId }))
      }
      const current = get().messages[botId]?.find((m) => m.id === messageId)
      if (current?.delivery === 'sending') updateMessage(botId, messageId, { delivery: 'accepted', error: undefined })
      ensureAccountLive(message.accountId, 'online', { onlyFrom: ['offline', 'error'] })
    }
    const applyError = (error: unknown, late = false) => {
      if (!isCurrent()) return
      if (error instanceof SendTimeoutError && isCurrentSession(bot, selection)) get().finishReply(botId)
      const current = get().messages[botId]?.find((m) => m.id === messageId)
      if (!current || current.delivery === 'sent') return
      if (error instanceof SendTimeoutError) {
        updateMessage(botId, messageId, { delivery: 'no-reply', error: SEND_STILL_PENDING_TEXT })
      } else if (error instanceof AdapterError && error.code === 'no-reply') {
        updateMessage(botId, messageId, deliveryAfterError(accepted, 'no-reply', error.message || NO_REPLY_TEXT))
      } else if (late && !accepted) {
        updateMessage(botId, messageId, { delivery: 'no-reply', error: SEND_TIMEOUT_TEXT })
      } else {
        updateMessage(botId, messageId, deliveryAfterError(accepted, 'other', errorMessage(error)))
      }
    }

    try {
      const outboundText =
        message.replyQuote && bot.platformId !== 'grok'
          ? `> ${quoteForBot(message).replace(/\n/g, '\n> ')}\n\n${message.text}`
          : message.text
      const receipt = await withTimeout(
        adapter.sendMessage({
          conversationId: botId,
          accountId: message.accountId,
          agentId: bot.selectedAgentId,
          sessionId: bot.activeSessionId,
          ...(bot.hermesSessionKey ? { hermesSessionKey: bot.hermesSessionKey } : {}),
          text: outboundText,
          attachments: message.attachments,
          replyToId: message.replyToId,
          replyQuote: message.replyQuote,
          onAccepted
        }),
        SEND_HARD_TIMEOUT_MS,
        (late) => {
          try {
            if (late.ok) applyReceipt(late.value)
            else applyError(late.error, true)
          } finally {
            finish()
          }
        }
      )
      applyReceipt(receipt)
    } catch (error) {
      timedOut = error instanceof SendTimeoutError
      applyError(error)
    } finally {
      if (!timedOut) finish()
    }
  }

  // A quoted picture reaches the bot as its web address, so it can tell which image was meant.
  const quoteForBot = (m: ChatMessage) =>
    m.replyThumb && /^https?:/i.test(m.replyThumb) ? `${m.replyQuote} ${m.replyThumb}` : m.replyQuote ?? ''

  const enqueueUserMessage = (bot: Bot, text: string, attachments?: AttachmentMeta[], clientMessageId?: string) => {
    const botId = bot.id
    const replyTarget = clientMessageId ? undefined : get().replyingTo[botId]
    const message: ChatMessage = {
      id: clientMessageId ?? createId('msg'),
      botId,
      accountId: bot.activeAccountId,
      ...(bot.selectedAgentId ? { agentId: bot.selectedAgentId } : {}),
      role: 'user',
      text,
      createdAt: Date.now(),
      delivery: 'sending',
      ...(replyTarget
        ? { replyToId: replyTarget.entryId, replyQuote: replyTarget.quote, ...(replyTarget.thumb ? { replyThumb: replyTarget.thumb } : {}) }
        : {}),
      attachments: attachments?.length ? attachments : undefined
    }
    set((state) => {
      const { [botId]: _clearedReply, ...restReplies } = state.replyingTo
      return {
        replyingTo: clientMessageId ? state.replyingTo : restReplies,
        messages: { ...state.messages, [botId]: [...(state.messages[botId] ?? []), message] }
      }
    })
    return message.id
  }

  // When each bot was last on screen (this run only); bots never opened count from app start.
  const startedAt = Date.now()
  const lastSeenAt = new Map<string, number>()

  const isBotBusy = (state: BotHubState, bot: Bot): boolean => {
    if (state.typing[bot.id]) return true
    if (bot.accountIds.some((id) => {
      const acc = state.accounts[id]
      return acc?.status === 'busy' || acc?.pending || state.activity[id]?.busy
    })) return true
    const list = state.messages[bot.id] ?? []
    return hasUnsettledDelivery(list)
  }

  /** One conversation's history through the platform's own history call (undefined: unavailable). */
  const fetchSessionMessages = async (bot: Bot, sessionId: string): Promise<ChatMessage[] | undefined> => {
    const botId = bot.id
    const bridge = electronBridge()
    if (bot.platformId === 'meta-muse') {
      if (!bridge?.muse?.loadSessionHistory) return undefined
      const rows = await bridge.muse.loadSessionHistory(bot.activeAccountId, sessionId)
      return rows.map((r) => ({
        id: r.id,
        botId,
        accountId: bot.activeAccountId,
        role: r.role,
        text: r.text,
        createdAt: r.createdAt,
        delivery: r.role === 'user' ? 'sent' : undefined,
        widgets: r.widgets,
        richWidgets: r.richWidgets,
        tools: r.tools,
        media: r.media
      }))
    }
    if (bot.platformId === 'hermes') {
      if (!bridge?.hermes?.rpc) return undefined
      const res = await bridge.hermes.rpc({
        accountId: bot.activeAccountId,
        op: 'getSessionMessages',
        sessionId
      })
      if (!res.ok || !Array.isArray(res.data)) return undefined
      const rows = res.data as Array<{
        id: string
        role: 'user' | 'assistant'
        text: string
        createdAt: number
        tools?: import('@/types').ChatToolCall[]
        media?: import('@/types').ChatMediaPart[]
      }>
      return rows.map((r) => ({
        id: r.id,
        botId,
        accountId: bot.activeAccountId,
        role: r.role === 'user' ? 'user' : 'bot',
        text: r.text,
        createdAt: r.createdAt,
        delivery: r.role === 'user' ? 'sent' : undefined,
        ...(r.tools?.length ? { tools: r.tools } : {}),
        ...(r.media?.length ? { media: r.media } : {})
      }))
    }
    if (bot.platformId === 'antigravity') {
      if (!bridge?.antigravity?.rpc) return undefined
      const res = await bridge.antigravity.rpc({
        accountId: bot.activeAccountId,
        action: 'getConversation',
        conversationId: sessionId
      })
      if (!res.ok || !res.data || typeof res.data !== 'object') return undefined
      const rows = (
        res.data as {
          messages?: Array<{
            id: string
            role: 'user' | 'assistant'
            text: string
            createdAt: number
            tools?: import('@/types').ChatToolCall[]
          }>
        }
      ).messages
      if (!Array.isArray(rows)) return undefined
      return rows.map((r) => ({
        id: r.id,
        botId,
        accountId: bot.activeAccountId,
        role: r.role === 'user' ? 'user' : 'bot',
        text: r.text,
        createdAt: r.createdAt,
        delivery: r.role === 'user' ? 'sent' : undefined,
        ...(r.tools?.length ? { tools: r.tools } : {})
      }))
    }
    if (bot.platformId === 'hark') {
      if (sessionId === HARK_DRAFT_SESSION) return []
      const result = await bridge?.hark.rpc({ accountId: bot.activeAccountId, op: 'conversationSnapshot', conversationId: sessionId })
      return result?.ok ? harkHistory(result.data, botId, bot.activeAccountId) : undefined
    }
    return undefined
  }

  /** Fetch the full current conversation again through the platform's existing history path. */
  const reloadTrimmedBot = (botId: string) => {
    const state = get()
    const bot = state.bots.find((b) => b.id === botId)
    if (!state.trimmedBots[botId] || !bot) return
    const acc = state.accounts[bot.activeAccountId]
    // Not now: an offline account cannot answer, and a working bot must not be touched. Retry on next open.
    if (!acc || (acc.status !== 'online' && acc.status !== 'busy') || isBotBusy(state, bot)) return
    const { [botId]: _done, ...rest } = state.trimmedBots
    set({ trimmedBots: rest })
    const sid = bot.activeSessionId
    if (bot.platformId === 'meta-muse' && sid) void get().switchMuseSession(botId, sid).catch(() => undefined)
    else if (bot.platformId === 'hermes' && sid) void get().switchHermesSession(botId, sid).catch(() => undefined)
    else if (bot.platformId === 'antigravity' && sid) void get().switchAntigravitySession(botId, sid).catch(() => undefined)
    else if (bot.platformId === 'hark' && sid) void get().switchHarkSession(botId, sid).catch(() => undefined)
    else if (bot.platformId === 'grok' && bot.selectedAgentId) get().setSelectedAgent(botId, bot.selectedAgentId)
    // cue: selectBot already re-hydrates (limit 300) whenever its account is live.
  }

  return {
    ...seed,
    typing: {},
    activity: {},
    selectedBotId: seed.bots[0]?.id ?? null,
    collapsedGroups: {},
    infoPanelOpen: true,
    sidebarCollapsed: false,
    sidebarWidth: SIDEBAR_DEFAULT,
    addBotOpen: false,
    addBotInitialPlatform: null,
    addBotKey: 0,
    onboardingOpen: false,
    paletteOpen: false,
    paletteQuery: '',
    paletteKey: 0,
    webSessionOpen: false,
    webSessionByBot: {},
    webSessionTargetUrl: null,
    settingsOpen: false,
    settingsTab: 'overview',
    activeDocument: null,
    replyingTo: {},
    hermesSessionErrors: {},
    chatActionErrors: {},
    dismissedGrokAgents: {},
    trimmedBots: {},

    setActiveDocument: (doc) => set({ activeDocument: doc }),

    setReplyTarget: (botId, target) =>
      set((state) => {
        if (!target) {
          if (!state.replyingTo[botId]) return state
          const { [botId]: _removed, ...rest } = state.replyingTo
          return { replyingTo: rest }
        }
        return { replyingTo: { ...state.replyingTo, [botId]: target } }
      }),

    deleteMessages: (botId, messageIds) =>
      set((state) => {
        const list = state.messages[botId]
        if (!list || messageIds.length === 0) return state
        const drop = new Set(messageIds)
        const nextList = list.filter((m) => !drop.has(m.id))
        if (nextList.length === list.length) return state
        return { messages: { ...state.messages, [botId]: nextList } }
      }),

    selectBot: (botId) => {
      const prevBotId = get().selectedBotId
      if (prevBotId && prevBotId !== botId) lastSeenAt.set(prevBotId, Date.now())
      const prevWebOpen = get().webSessionOpen
      set((state) => {
        const targetBot = state.bots.find((b) => b.id === botId)
        let nextAccounts = state.accounts
        if (targetBot) {
          for (const accId of targetBot.accountIds) {
            const acc = nextAccounts[accId]
            if (acc && (acc.unread ?? 0) > 0) {
              nextAccounts = {
                ...nextAccounts,
                [accId]: { ...acc, unread: 0 }
              }
            }
          }
        }
        const rememberedMap =
          state.selectedBotId && state.selectedBotId !== botId
            ? { ...(state.webSessionByBot ?? {}), [state.selectedBotId]: state.webSessionOpen }
            : (state.webSessionByBot ?? {})
        const nextWebSessionOpen =
          state.selectedBotId === botId
            ? state.webSessionOpen
            : Boolean(botId && rememberedMap[botId])
        return {
          selectedBotId: botId,
          settingsOpen: false,
          webSessionOpen: nextWebSessionOpen,
          webSessionByBot: rememberedMap,
          webSessionTargetUrl: state.selectedBotId === botId ? state.webSessionTargetUrl : null,
          activeDocument:
            state.activeDocument && targetBot?.accountIds.includes(state.activeDocument.accountId)
              ? state.activeDocument
              : null,
          accounts: nextAccounts,
          bots: state.bots.map((b) => (b.id === botId && b.unread > 0 ? { ...b, unread: 0 } : b))
        }
      })
      if (prevWebOpen && prevBotId && prevBotId !== botId) {
        const prevBot = get().bots.find((b) => b.id === prevBotId)
        const prevAcc = prevBot ? get().accounts[prevBot.activeAccountId] : undefined
        if (prevAcc && (prevAcc.status === 'offline' || prevAcc.status === 'error') && !prevAcc.pending) {
          void get().connectAccount(prevAcc.id)
        }
      }
      if (botId) {
        const nextBot = get().bots.find((b) => b.id === botId)
        const nextAcc = nextBot ? get().accounts[nextBot.activeAccountId] : undefined
        if (nextAcc && (nextAcc.status === 'offline' || nextAcc.status === 'error') && !nextAcc.pending) {
          void get().connectAccount(nextAcc.id)
        }
        if (nextBot?.platformId === 'cue' && nextAcc && (nextAcc.status === 'online' || nextAcc.status === 'busy')) {
          void hydrateCueHistoryForBot(nextAcc.id, nextBot)
        }
        reloadTrimmedBot(botId)
      }
    },

    toggleGroup: (groupId) =>
      set((state) => ({
        collapsedGroups: { ...state.collapsedGroups, [groupId]: !state.collapsedGroups[groupId] }
      })),

    addGroup: (name) => {
      const id = createId('grp')
      set((state) => {
        const requested = name?.trim()
        const finalName = requested
          ? (
              state.groups.some((g) => g.name.toLowerCase() === requested.toLowerCase())
                ? uniqueGroupName(state.groups, requested)
                : requested
            )
          : uniqueGroupName(state.groups)
        return {
          groups: [...state.groups, { id, name: finalName }],
          collapsedGroups: { ...state.collapsedGroups, [id]: false }
        }
      })
      return id
    },

    renameGroup: (groupId, name) => {
      const next = name.trim()
      if (!next) return
      set((state) => ({
        groups: state.groups.map((g) => (g.id === groupId ? { ...g, name: next } : g))
      }))
    },

    removeGroup: (groupId) =>
      set((state) => {
        if (state.groups.length <= 1) return state
        if (!state.groups.some((g) => g.id === groupId)) return state
        const fallback = state.groups.find((g) => g.id !== groupId)
        if (!fallback) return state
        const { [groupId]: _collapsed, ...collapsedGroups } = state.collapsedGroups
        return {
          groups: state.groups.filter((g) => g.id !== groupId),
          bots: state.bots.map((b) => (b.groupId === groupId ? { ...b, groupId: fallback.id } : b)),
          collapsedGroups
        }
      }),

    moveBotToGroup: (botId, groupId) =>
      set((state) => {
        if (!state.groups.some((g) => g.id === groupId)) return state
        return {
          bots: state.bots.map((b) => (b.id === botId ? { ...b, groupId } : b)),
          collapsedGroups: { ...state.collapsedGroups, [groupId]: false }
        }
      }),

    togglePinBot: (botId) =>
      set((state) => ({ bots: state.bots.map((b) => (b.id === botId ? { ...b, pinned: !b.pinned } : b)) })),

    reorderBot: (botId, groupId, beforeId) =>
      set((state) => {
        if (botId === beforeId) return state
        const bot = state.bots.find((b) => b.id === botId)
        if (!bot || !state.groups.some((g) => g.id === groupId)) return state
        const rest = state.bots.filter((b) => b.id !== botId)
        const moved = { ...bot, groupId }
        let at = beforeId ? rest.findIndex((b) => b.id === beforeId) : -1
        if (at < 0) {
          const lastInGroup = rest.map((b) => b.groupId).lastIndexOf(groupId)
          at = lastInGroup < 0 ? rest.length : lastInGroup + 1
        }
        rest.splice(at, 0, moved)
        return { bots: rest }
      }),

    toggleInfoPanel: () => set((state) => ({ infoPanelOpen: !state.infoPanelOpen })),

    toggleSidebarCollapsed: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

    setSidebarWidth: (width) =>
      set({ sidebarWidth: Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width))) }),

    setAddBotOpen: (open, initialPlatform = null) =>
      set((state) =>
        open
          ? {
              addBotOpen: true,
              addBotInitialPlatform: initialPlatform,
              addBotKey: state.addBotKey + 1,
              onboardingOpen: false
            }
          : { addBotOpen: false, addBotInitialPlatform: null }
      ),

    setOnboardingOpen: (open) => set({ onboardingOpen: open }),

    toggleWebSession: () => {
      const wasOpen = get().webSessionOpen
      const selectedBotId = get().selectedBotId
      set((state) => {
        const nextOpen = !state.webSessionOpen
        return {
          webSessionOpen: nextOpen,
          webSessionByBot: state.selectedBotId
            ? { ...(state.webSessionByBot ?? {}), [state.selectedBotId]: nextOpen }
            : (state.webSessionByBot ?? {}),
          webSessionTargetUrl: state.webSessionOpen ? null : state.webSessionTargetUrl
        }
      })
      if (selectedBotId) {
        const bot = get().bots.find((b) => b.id === selectedBotId)
        const acc = bot ? get().accounts[bot.activeAccountId] : undefined
        if (wasOpen && acc && (acc.status === 'offline' || acc.status === 'error')) {
          void get().connectAccount(acc.id)
        }
      }
    },

    openWebSessionAt: (url) =>
      set((state) => ({
        webSessionOpen: true,
        webSessionByBot: state.selectedBotId
          ? { ...(state.webSessionByBot ?? {}), [state.selectedBotId]: true }
          : (state.webSessionByBot ?? {}),
        webSessionTargetUrl: url && /^https?:\/\//i.test(url) ? url : null
      })),

    closeWebSession: () => {
      const wasOpen = get().webSessionOpen
      const selectedBotId = get().selectedBotId
      set((state) => ({
        webSessionOpen: false,
        webSessionByBot: state.selectedBotId
          ? { ...(state.webSessionByBot ?? {}), [state.selectedBotId]: false }
          : (state.webSessionByBot ?? {}),
        webSessionTargetUrl: null
      }))
      if (wasOpen && selectedBotId) {
        const bot = get().bots.find((b) => b.id === selectedBotId)
        const acc = bot ? get().accounts[bot.activeAccountId] : undefined
        if (acc && (acc.status === 'offline' || acc.status === 'error')) {
          void get().connectAccount(acc.id)
        }
      }
    },

    setSettingsOpen: (open, tab) =>
      set((state) => ({
        settingsOpen: open,
        settingsTab: tab ?? state.settingsTab
      })),

    openPalette: (query = '') =>
      set((state) => ({ paletteOpen: true, paletteQuery: query, paletteKey: state.paletteKey + 1 })),

    closePalette: () => set({ paletteOpen: false }),

    selectAdjacentBot: (offset) => {
      const state = get()
      const ordered = state.groups.flatMap((g) => state.bots.filter((b) => b.groupId === g.id))
      if (ordered.length === 0) return
      const index = ordered.findIndex((b) => b.id === state.selectedBotId)
      const next = ordered[(index + offset + ordered.length) % ordered.length]
      if (next) get().selectBot(next.id)
    },

    addBot: (input) => {
      const state = get()
      const { ids, created } = materializeAccounts(input.platformId, input.accounts, state.accounts)
      if (ids.length === 0) throw new Error('A bot needs at least one account.')

      let groups = state.groups
      let groupId: string
      const choice = input.group
      if (choice?.kind === 'existing' && groups.some((g) => g.id === choice.groupId)) {
        groupId = choice.groupId
      } else if (choice?.kind === 'new' && choice.name.trim()) {
        const name = choice.name.trim()
        const match = groups.find((g) => g.name.toLowerCase() === name.toLowerCase())
        groupId = match?.id ?? createId('grp')
        if (!match) groups = [...groups, { id: groupId, name }]
      } else {
        const selectedGroup = state.bots.find((b) => b.id === state.selectedBotId)?.groupId
        groupId = selectedGroup ?? groups[0]?.id ?? createId('grp')
        if (!groups.some((g) => g.id === groupId)) groups = [...groups, { id: groupId, name: 'Workspace' }]
      }

      const bot: Bot = {
        id: input.id ?? createId('bot'),
        name: input.name.trim() || getPlatform(input.platformId).name,
        emoji: input.emoji ?? '🤖',
        avatar: input.avatar,
        ...(input.avatarShape ? { avatarShape: input.avatarShape } : {}),
        ...(input.avatarColor ? { avatarColor: input.avatarColor } : {}),
        ...(input.selectedAgentId ? { selectedAgentId: input.selectedAgentId } : {}),
        description: input.description?.trim() ?? '',
        platformId: input.platformId,
        groupId,
        accountIds: ids,
        activeAccountId: ids[0]!,
        memory: [],
        notes: input.notes?.trim() ?? '',
        createdAt: Date.now(),
        unread: 0
      }

      set((s) => {
        const nextSelectedId = input.background ? (s.selectedBotId ?? bot.id) : bot.id
        const switchedSelection = nextSelectedId !== s.selectedBotId
        const rememberedMap =
          switchedSelection && s.selectedBotId
            ? { ...(s.webSessionByBot ?? {}), [s.selectedBotId]: s.webSessionOpen }
            : (s.webSessionByBot ?? {})
        return {
          groups,
          bots: [...s.bots, bot],
          accounts: { ...s.accounts, ...created },
          messages: { ...s.messages, [bot.id]: [] },
          selectedBotId: nextSelectedId,
          webSessionOpen: switchedSelection ? Boolean(rememberedMap[nextSelectedId]) : s.webSessionOpen,
          webSessionByBot: rememberedMap,
          webSessionTargetUrl: switchedSelection ? null : s.webSessionTargetUrl,
          collapsedGroups: { ...s.collapsedGroups, [groupId]: false },
          addBotOpen: input.background ? s.addBotOpen : false
        }
      })

      const accounts = get().accounts
      void autoAssignProxyPool(ids).catch(() => undefined)
      for (const id of ids) if (accounts[id]?.status === 'offline') void get().connectAccount(id)
      return bot.id
    },

    addAccountsToBot: (botId, drafts) => {
      const state = get()
      const bot = state.bots.find((b) => b.id === botId)
      if (!bot) return
      const { ids, created } = materializeAccounts(bot.platformId, drafts, state.accounts)
      const newIds = ids.filter((id) => !bot.accountIds.includes(id))
      if (newIds.length === 0) return

      set((s) => ({
        accounts: { ...s.accounts, ...created },
        bots: s.bots.map((b) => (b.id === botId ? { ...b, accountIds: [...b.accountIds, ...newIds] } : b))
      }))

      const accounts = get().accounts
      void autoAssignProxyPool(newIds).catch(() => undefined)
      for (const id of newIds) if (accounts[id]?.status === 'offline') void get().connectAccount(id)
    },

    renameBot: (botId, name) => {
      const trimmed = name.trim()
      if (trimmed) patchBot(botId, () => ({ name: trimmed }))
    },

    setBotAvatar: (botId, avatar) => patchBot(botId, () => ({ avatar })),

    setBotCharacter: (botId, character) =>
      patchBot(botId, (b) => ({
        avatarShape: character.shape ?? b.avatarShape,
        avatarColor: character.color ?? b.avatarColor
      })),

    removeBot: async (botId) => {
      const state = get()
      const bot = state.bots.find((b) => b.id === botId)
      if (!bot) return
      markSessionSelection(botId)
      transcriptTransitions.delete(botId)
      pendingHarkSelections.delete(botId)
      invalidateCueRoster(bot, bot.accountIds)
      const orphaned = bot.accountIds.filter((id) => !state.bots.some((b) => b.id !== botId && b.accountIds.includes(id)))
      for (const accountId of orphaned) invalidateAccount(accountId)
      const cleanup = orphaned.flatMap((id) => state.accounts[id] ? [cleanupAccount(state.accounts[id]!)] : [])
      const ordered = state.groups.flatMap((g) => state.bots.filter((b) => b.groupId === g.id))
      const index = ordered.findIndex((b) => b.id === botId)
      const neighbour = ordered[index + 1] ?? ordered[index - 1]
      set((s) => {
        const { [botId]: _messages, ...messages } = s.messages
        const turn = clearedSession(s, bot)
        const { [botId]: _sessionError, ...hermesSessionErrors } = s.hermesSessionErrors
        let dismissedGrokAgents = s.dismissedGrokAgents
        if (
          bot.platformId === 'grok' &&
          bot.selectedAgentId &&
          bot.activeAccountId &&
          !orphaned.includes(bot.activeAccountId)
        ) {
          const prev = s.dismissedGrokAgents[bot.activeAccountId] ?? []
          if (!prev.includes(bot.selectedAgentId)) {
            dismissedGrokAgents = {
              ...s.dismissedGrokAgents,
              [bot.activeAccountId]: [...prev, bot.selectedAgentId]
            }
          }
        }
        return {
          ...turn,
          bots: s.bots.filter((b) => b.id !== botId),
          messages,
          accounts: orphaned.reduce(omitKey<BotAccount>, turn.accounts),
          activity: orphaned.reduce(omitKey, turn.activity),
          hermesSessionErrors,
          dismissedGrokAgents,
          selectedBotId: s.selectedBotId === botId ? (neighbour?.id ?? null) : s.selectedBotId
        }
      })
      flushWorkspacePersistence()
      await Promise.all(cleanup)
    },

    sendMessage: async (botId, text, attachments) => {
      const bot = get().bots.find((b) => b.id === botId)
      const trimmed = text.trim()
      if (!bot || (!trimmed && !attachments?.length)) return
      await deliver(botId, enqueueUserMessage(bot, trimmed, attachments))
    },

    queueMobileMessage: ({ botId, text, clientMessageId, attachments }) => {
      const state = get()
      const bot = state.bots.find((b) => b.id === botId)
      if (!bot) return { ok: false, status: 404, message: 'Bot no longer exists on the desktop' }
      const trimmed = text.trim()
      const validAttachments: AttachmentMeta[] = (attachments ?? [])
        .filter((a) => a && typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:'))
        .map((a, idx) => {
          const comma = a.dataUrl.indexOf(',')
          const dataBase64 = comma >= 0 ? a.dataUrl.slice(comma + 1) : a.dataUrl
          return {
            id: `${clientMessageId}_att_${idx}`,
            name: a.name || `attachment_${idx + 1}`,
            size: a.size ?? Math.round((dataBase64.length * 3) / 4),
            mimeType: a.mimeType || 'application/octet-stream',
            dataBase64
          }
        })
      if (!trimmed && validAttachments.length === 0) {
        return { ok: false, status: 400, message: 'Message text is required' }
      }
      const existing = state.messages[botId]?.find((m) => m.id === clientMessageId)
      if (existing) {
        return existing.role === 'user' && existing.text === trimmed
          ? { ok: true, messageId: existing.id }
          : { ok: false, status: 409, message: 'Message ID is already in use' }
      }
      const account = state.accounts[bot.activeAccountId]
      if (!account || account.status === 'offline' || account.status === 'error') {
        return { ok: false, status: 409, message: 'Bot account is not connected on the desktop' }
      }
      if (!adapterRegistry.has(bot.platformId)) {
        return { ok: false, status: 503, message: 'Bot platform is unavailable on the desktop' }
      }
      const messageId = enqueueUserMessage(
        bot,
        trimmed,
        validAttachments.length > 0 ? validAttachments : undefined,
        clientMessageId
      )
      void deliver(botId, messageId)
      return { ok: true, messageId }
    },

    retryMessage: async (botId, messageId) => {
      const message = get().messages[botId]?.find((m) => m.id === messageId)
      if (!message || (message.delivery !== 'failed' && message.delivery !== 'no-reply')) return
      // Retrying would silently drop the files (or send an empty message).
      if (hasLostAttachments(message)) {
        // Keep "delivered" messages delivered: looking unsent invites a duplicate.
        updateMessage(botId, messageId, {
          delivery: message.delivery === 'no-reply' ? 'no-reply' : 'failed',
          error: ATTACHMENTS_LOST_TEXT
        })
        return
      }
      await deliver(botId, messageId, true)
    },

    receiveMessage: (incoming) =>
      set((state) => {
        const targetBot = getEventBot(state.bots, incoming.accountId, incoming.conversationId, incoming.sessionId)
        if (!targetBot) return state
        const botId = targetBot.id
        const list = state.messages[botId] ?? []
        const existingIdx = list.findIndex((m) => m.id === incoming.id && m.accountId === incoming.accountId)
        const prev = list[existingIdx]
        const authoritative = Boolean((incoming as { authoritative?: boolean }).authoritative)
        const text = authoritative
          ? incoming.text
          : incoming.text && (!prev?.text || !isOmittedPlaceholderText(incoming.text))
            ? incoming.text
            : prev?.text ?? ''
        const message: ChatMessage = {
          id: incoming.id,
          botId,
          accountId: incoming.accountId,
          ...(targetBot.selectedAgentId ? { agentId: targetBot.selectedAgentId } : {}),
          role: 'bot',
          text,
          createdAt: prev?.createdAt ?? incoming.createdAt,
          widgets: incoming.widgets?.length ? incoming.widgets : prev?.widgets,
          tools: incoming.tools?.length ? incoming.tools : prev?.tools,
          media: prevMediaMerge(prev?.media, incoming.media),
          richWidgets: incoming.richWidgets?.length ? incoming.richWidgets : prev?.richWidgets
        }
        const liveAccounts = applyAccountLive(state.accounts, incoming.accountId, 'online', ['offline', 'error'])
        const accounts = applySettleAccountBusy(liveAccounts, state.activity, state.typing, state.bots, incoming.accountId, botId)
        if (prev && shallow(prev, message)) {
          finalizedReplies.add(prev)
          return accounts === state.accounts ? state : { accounts }
        }
        finalizedReplies.add(message)
        const nextList = existingIdx >= 0
          ? list.map((m, i) => (i === existingIdx ? message : m))
          : clearNoReplyFlag([...list, message], incoming.accountId)
        return withIncomingReply(state, targetBot, nextList, existingIdx < 0, accounts)
      }),

    applyMessageDelta: (messageId, conversationId, accountId, text, widgets, tools, media, richWidgets) =>
      set((state) => {
        const targetBot = getEventBot(state.bots, accountId, conversationId)
        if (!targetBot) return state
        const botId = targetBot.id
        const list = state.messages[botId] ?? []
        const existingIdx = list.findIndex((m) => m.id === messageId && m.accountId === accountId)
        const liveAccounts = applyAccountLive(state.accounts, accountId, 'busy', ['offline', 'error'])
        if (existingIdx >= 0) {
          const prevMsg = list[existingIdx]!
          const prev = prevMsg.text
          // Reconnect/backfill can briefly send a shorter snapshot — never shrink,
          // unless replacing an omitted-body placeholder with hydrated real text.
          const next = text && ((text.length > prev.length && !finalizedReplies.has(prevMsg)) ||
            (isOmittedPlaceholderText(prev) && !isOmittedPlaceholderText(text))) ? text : prev
          const nextWidgets = widgets?.length ? widgets : prevMsg.widgets
          const nextTools = tools?.length ? tools : prevMsg.tools
          const nextMedia = prevMediaMerge(prevMsg.media, media)
          const nextRich = richWidgets?.length ? richWidgets : prevMsg.richWidgets
          if (
            next === prev &&
            nextWidgets === prevMsg.widgets &&
            nextTools === prevMsg.tools &&
            nextMedia === prevMsg.media &&
            nextRich === prevMsg.richWidgets
          ) {
            return liveAccounts === state.accounts ? state : { accounts: liveAccounts }
          }
          const message = {
            ...prevMsg, text: next, widgets: nextWidgets, tools: nextTools, media: nextMedia, richWidgets: nextRich
          }
          if (finalizedReplies.has(prevMsg)) finalizedReplies.add(message)
          const updated = list.slice()
          updated[existingIdx] = message
          return { accounts: liveAccounts, messages: { ...state.messages, [botId]: updated } }
        }
        const message: ChatMessage = {
          id: messageId,
          botId,
          accountId,
          ...(targetBot.selectedAgentId ? { agentId: targetBot.selectedAgentId } : {}),
          role: 'bot',
          text,
          createdAt: Date.now(),
          widgets: widgets?.length ? widgets : undefined,
          tools: tools?.length ? tools : undefined,
          media: media?.length ? media : undefined,
          richWidgets: richWidgets?.length ? richWidgets : undefined
        }
        return withIncomingReply(state, targetBot, clearNoReplyFlag([...list, message], accountId), true, liveAccounts)
      }),

    setTyping: (botIdOrAccountId, isTyping) =>
      set((state) => {
        const matchedBot = state.bots.find((b) => b.id === botIdOrAccountId) ??
          getEventBot(state.bots, botIdOrAccountId)
        if (!matchedBot) return state
        const { id: botId, activeAccountId: accId } = matchedBot
        const typingUnchanged = (state.typing[botId] === true) === isTyping
        const typing = typingUnchanged ? state.typing : { ...state.typing }
        if (!typingUnchanged) {
          if (isTyping) typing[botId] = true
          else delete typing[botId]
        }
        const accounts = isTyping
          ? applyAccountLive(state.accounts, accId, 'busy', ['offline', 'error'])
          : applySettleAccountBusy(state.accounts, state.activity, typing, state.bots, accId, botId)
        if (typingUnchanged && accounts === state.accounts) return state
        return {
          ...(typingUnchanged ? {} : { typing }),
          ...(accounts === state.accounts ? {} : { accounts })
        }
      }),

    finishReply: (botId, stalled = false) =>
      set((state) => {
        const bot = state.bots.find((b) => b.id === botId)
        if (!bot) return state
        const turn = clearedTurn(state, bot)
        const list = state.messages[botId]
        const messages = stalled && list ? markStalledReply(list, bot.activeAccountId) : list
        if (messages === list && turn.typing === state.typing &&
            turn.activity === state.activity && turn.accounts === state.accounts) return state
        return {
          ...turn,
          ...(messages && messages !== list ? { messages: { ...state.messages, [botId]: messages } } : {})
        }
      }),

    setActivity: (accountId, activity) =>
      set((state) => {
        if (!keepActivity(activity)) {
          const hadActivity = accountId in state.activity
          let nextActivity = state.activity
          if (hadActivity) {
            const { [accountId]: _removed, ...rest } = state.activity
            nextActivity = rest
          }
          const nextAccounts = applySettleAccountBusy(
            state.accounts,
            nextActivity,
            state.typing,
            state.bots,
            accountId
          )
          if (!hadActivity && nextAccounts === state.accounts) return state
          return {
            ...(hadActivity ? { activity: nextActivity } : {}),
            ...(nextAccounts === state.accounts ? {} : { accounts: nextAccounts })
          }
        }
        const prev = state.activity[accountId]
        const activityUnchanged = Boolean(
          prev &&
            prev.code === activity.code &&
            prev.text === activity.text &&
            prev.emoji === activity.emoji &&
            prev.busy === activity.busy &&
            prev.subagents === activity.subagents &&
            prev.ctaLabel === activity.ctaLabel
        )
        const nextActivity = activityUnchanged
          ? state.activity
          : { ...state.activity, [accountId]: activity }
        const nextAccounts = activity.busy
          ? applyAccountLive(state.accounts, accountId, 'busy', ['offline', 'error'])
          : state.accounts
        if (activityUnchanged && nextAccounts === state.accounts) return state
        return {
          ...(activityUnchanged ? {} : { activity: nextActivity }),
          ...(nextAccounts === state.accounts ? {} : { accounts: nextAccounts })
        }
      }),

    setMessageWidgets: (botId, messageId, widgets) =>
      set((state) => {
        const list = state.messages[botId] ?? []
        const idx = list.findIndex((m) => m.id === messageId)
        if (idx < 0) return state
        return {
          messages: {
            ...state.messages,
            [botId]: list.map((m, i) => (i === idx ? { ...m, widgets } : m))
          }
        }
      }),

    selectChatOption: async (botId, messageId, widgetId, selectedText, optionIndex) => {
      const state = get()
      const bot = state.bots.find((b) => b.id === botId)
      if (!bot) return
      const list = state.messages[botId] ?? []
      const host = list.find((m) => m.id === messageId)
      const widget = host?.widgets?.find((w) => w.widgetId === widgetId)
      if (!host || !widget) return
      const adapter = adapterRegistry.get(bot.platformId) as {
        selectOptionWidget?: (a: {
          accountId: string
          conversationId: string
          hostMessageId: string
          widget: NonNullable<ChatMessage['widgets']>[number]
          selectedText: string
          optionIndex: number
        }) => Promise<void>
      }
      const markChosen = (selected: string | undefined) =>
        set((s) => ({
          messages: {
            ...s.messages,
            [botId]: (s.messages[botId] ?? []).map((m) =>
              m.id !== messageId || !m.widgets
                ? m
                : { ...m, widgets: m.widgets.map((w) => (w.widgetId === widgetId ? { ...w, selectedText: selected } : w)) }
            )
          }
        }))
      if (!adapter?.selectOptionWidget) {
        // Platforms without a native option call (Grok, Hark, Dot): the chip
        // is just a reply, so send it as a normal message. Before, the chip
        // showed a "sent" bubble while nothing was sent at all.
        markChosen(selectedText)
        await get().sendMessage(botId, selectedText)
        return
      }
      const optId = createId('opt')
      set((s) => {
        const msgs = s.messages[botId] ?? []
        const nextMsgs = msgs.map((m) => {
          if (m.id !== messageId || !m.widgets) return m
          return {
            ...m,
            widgets: m.widgets.map((w) =>
              w.widgetId === widgetId ? { ...w, selectedText } : w
            )
          }
        })
        const userMsg: ChatMessage = {
          id: optId,
          botId,
          accountId: bot.activeAccountId,
          role: 'user',
          text: selectedText,
          createdAt: Date.now(),
          delivery: 'sending'
        }
        return { messages: { ...s.messages, [botId]: [...nextMsgs, userMsg] } }
      })
      try {
        await adapter.selectOptionWidget({
          accountId: bot.activeAccountId,
          conversationId: botId,
          hostMessageId: messageId,
          widget,
          selectedText,
          optionIndex
        })
        updateMessage(botId, optId, { delivery: 'sent', error: undefined })
        ensureAccountLive(bot.activeAccountId, 'online', { onlyFrom: ['offline', 'error'] })
      } catch (error) {
        // Unlock the chips so the user can pick again; keep the reason visible.
        markChosen(undefined)
        updateMessage(botId, optId, { delivery: 'failed', error: errorMessage(error) })
      }
    },

    cancelGeneration: async (botId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (!bot) return
      const selection = sessionSelections.get(botId)
      get().finishReply(botId)
      setChatActionError(botId)
      try {
        await cancelPlatformTurn(bot)
      } catch (error) {
        if (isCurrentSession(bot, selection)) setChatActionError(botId, errorMessage(error))
      }
    },

    switchMuseSession: async (botId, sessionId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (!bot || bot.platformId !== 'meta-muse') return
      const { selection, before, target } = beginHistorySelection(bot, sessionId)
      const hydrated = await fetchSessionMessages(bot, sessionId)
        .catch((error) => reportHistoryError(target, selection, error))
      if (!hydrated || !isCurrentSession(target, selection)) return
      commitHistory(target, selection, before, hydrated)
    },

    startNewMuseSession: async (botId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (!bot || bot.platformId !== 'meta-muse') return
      const selection = markSessionSelection(botId)
      const bridge = electronBridge()
      setChatActionError(botId)
      try {
        if (!bridge?.muse?.startSession) throw new Error(t('Muse connection unavailable'))
        const res = await bridge.muse.startSession(bot.activeAccountId)
        const id = res?.sessionId
        if (typeof id !== 'string' || !id.trim()) throw new Error(t('Muse returned no session ID'))
        if (isCurrentSession(bot, selection)) setFreshSession(bot, id.trim())
      } catch (error) {
        if (isCurrentSession(bot, selection)) {
          setChatActionError(botId, t('Could not start a new conversation. {reason}', { reason: errorMessage(error) }))
        }
      }
    },

    startNewGrokSession: async (botId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (bot?.platformId !== 'grok' || !bot.selectedAgentId) return
      const grok = electronBridge()?.grok
      if (!grok?.rpc) throw new Error(t('Grok connection unavailable'))
      const selection = markSessionSelection(botId)
      let result
      try {
        result = await grok.rpc({
          accountId: bot.activeAccountId,
          op: 'call',
          method: 'StartFreshGrokBotConversation',
          params: { agent_id: bot.selectedAgentId }
        })
      } catch (error) {
        if (isCurrentSession(bot, selection)) throw error
        return
      }
      if (!isCurrentSession(bot, selection)) return
      if (!result.ok) throw new Error(result.message)
      setFreshSession(bot, undefined)
      get().setSelectedAgent(botId, bot.selectedAgentId)
    },

    applyHarkHistory: (botId, accountId, sessionId, messages) => set((s) => {
      const bot = s.bots.find((b) => b.id === botId)
      if (bot?.activeAccountId !== accountId || bot.activeSessionId !== sessionId) return s
      const hydrated = harkHistory({ messages }, botId, accountId)
      return {
        accounts: applyAccountLive(s.accounts, accountId, 'online', ['offline', 'error']),
        messages: { ...s.messages, [botId]: mergeHydratedMessages(s.messages[botId] ?? [], hydrated) }
      }
    }),

    switchHarkSession: async (botId, sessionId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (bot?.platformId !== 'hark') return
      const selection = markSessionSelection(botId)
      pendingHarkSelections.set(botId, selection)
      try {
        await loadHarkSession(bot, sessionId, selection)
      } finally {
        if (pendingHarkSelections.get(botId) === selection) pendingHarkSelections.delete(botId)
      }
    },

    startNewHarkSession: async (botId, title) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (bot?.platformId !== 'hark') return undefined
      const selection = markSessionSelection(botId)
      pendingHarkSelections.set(botId, selection)
      try {
        const result = await electronBridge()?.hark?.rpc({ accountId: bot.activeAccountId, op: 'createConversation', title })
        if (!isCurrentSession(bot, selection)) return undefined
        if (!result?.ok) throw new Error(result?.message ?? 'Hark unavailable')
        const conversationId = (result.data as { conversationId?: string } | null)?.conversationId
        if (typeof conversationId !== 'string' || !conversationId.trim()) throw new Error('Hark returned no conversation ID')
        setFreshSession(bot, conversationId)
        return conversationId
      } finally {
        if (pendingHarkSelections.get(botId) === selection) pendingHarkSelections.delete(botId)
      }
    },

    startHarkDraft: (botId) => {
      markSessionSelection(botId)
      const bot = get().bots.find((b) => b.id === botId)
      if (bot) setFreshSession(bot, HARK_DRAFT_SESSION)
    },

    switchHermesSession: async (botId, sessionId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (!bot || bot.platformId !== 'hermes') return
      setHermesSessionError(botId)
      const { selection, before, target } = beginHistorySelection(bot, sessionId)
      const hydrated = await fetchSessionMessages(bot, sessionId)
        .catch((error) => reportHistoryError(target, selection, error))
      if (!hydrated || !isCurrentSession(target, selection)) return
      commitHistory(target, selection, before, hydrated)
    },

    startNewHermesSession: async (botId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (!bot || bot.platformId !== 'hermes') return false
      const selection = markSessionSelection(botId)
      setHermesSessionError(botId)
      const bridge = electronBridge()
      try {
        if (!bridge?.hermes?.rpc) throw new Error(t('Hermes connection unavailable'))
        const res = await bridge.hermes.rpc({
          accountId: bot.activeAccountId,
          op: 'createSession',
          title: bot.name
        })
        if (!isCurrentSession(bot, selection)) return false
        if (!res.ok) {
          if (![404, 405, 501].includes(res.status)) throw new Error(res.message)
          // Legacy gateways identify a conversation by X-Hermes-Session-Key.
          setFreshSession(bot, undefined, createId('hermes'))
          return true
        }
        const id = (res.data as { id?: unknown } | null)?.id
        if (typeof id !== 'string' || !id.trim()) throw new Error(t('Hermes returned no session ID'))
        setFreshSession(bot, id.trim(), createId('hermes'))
        return true
      } catch (error) {
        if (isCurrentSession(bot, selection)) setHermesSessionError(botId, errorMessage(error))
        return false
      }
    },

    switchAntigravitySession: async (botId, sessionId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (!bot || bot.platformId !== 'antigravity') return
      const { selection, before, target } = beginHistorySelection(bot, sessionId)
      const hydrated = await fetchSessionMessages(bot, sessionId)
        .catch((error) => reportHistoryError(target, selection, error))
      if (!hydrated || !isCurrentSession(target, selection)) return
      commitHistory(target, selection, before, hydrated)
    },

    startNewAntigravitySession: (botId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (!bot || bot.platformId !== 'antigravity') return
      markSessionSelection(botId)
      setFreshSession(bot, undefined)
    },

    loadConversation: async (botId, conversationId) => {
      const bot = get().bots.find((b) => b.id === botId)
      return bot ? fetchSessionMessages(bot, conversationId) : undefined
    },

    switchConversation: async (botId, conversationId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (!bot) return
      if (bot.platformId === 'meta-muse') return get().switchMuseSession(botId, conversationId)
      if (bot.platformId === 'hermes') return get().switchHermesSession(botId, conversationId)
      if (bot.platformId === 'antigravity') return get().switchAntigravitySession(botId, conversationId)
      if (bot.platformId === 'hark') return get().switchHarkSession(botId, conversationId)
    },

    updateNotes: (botId, notes) => patchBot(botId, () => ({ notes })),

    addMemory: (botId, text) => {
      const trimmed = text.trim()
      if (!trimmed) return
      patchBot(botId, (bot) => ({
        memory: [...bot.memory, { id: createId('mem'), text: trimmed, createdAt: Date.now() }]
      }))
    },

    removeMemory: (botId, memoryId) =>
      patchBot(botId, (bot) => ({ memory: bot.memory.filter((m) => m.id !== memoryId) })),

    removeAccountFromBot: (botId, accountId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (!bot || bot.accountIds.length <= 1 || !bot.accountIds.includes(accountId)) return
      if (bot.activeAccountId === accountId) {
        const replacement = bot.accountIds.find((id) => id !== accountId)!
        get().setActiveAccount(botId, replacement)
      }
      invalidateCueRoster(bot, [accountId])
      patchBot(botId, (b) => ({ accountIds: b.accountIds.filter((id) => id !== accountId) }))
    },

    setActiveAccount: (botId, accountId) => {
      set((state) => {
        const bot = state.bots.find((b) => b.id === botId && b.accountIds.includes(accountId))
        if (!bot) return state
        const changed = bot.activeAccountId !== accountId
        if (changed) {
          markSessionSelection(botId)
          transcriptTransitions.delete(botId)
        }
        const turn = changed ? clearedSession(state, bot) : undefined
        const accounts = turn?.accounts ?? state.accounts
        const account = accounts[accountId]
        const resetSession = changed && (bot.platformId === 'hark' || bot.platformId === 'cue')
        return {
          ...turn,
          ...(resetSession ? { messages: { ...state.messages, [botId]: [] } } : {}),
          ...(changed ? { bots: state.bots.map((b) => b.id === botId
            ? { ...b, activeAccountId: accountId, ...(resetSession ? { activeSessionId: undefined } : {}) }
            : b) } : {}),
          accounts: account?.unread ? { ...accounts, [accountId]: { ...account, unread: 0 } } : accounts
        }
      })
      const acc = get().accounts[accountId]
      if (acc && acc.status === 'offline') {
        void get().connectAccount(accountId)
      } else if (acc?.platformId === 'cue') {
        const bot = get().bots.find((b) => b.id === botId && b.activeAccountId === accountId)
        if (bot) void hydrateCueHistoryForBot(accountId, bot)
      }
    },

    setSelectedAgent: (botId, agentId) => {
      const trimmed = agentId.trim()
      if (!trimmed) return
      const botBefore = get().bots.find((b) => b.id === botId)
      if (!botBefore) return
      const selection = markSessionSelection(botId)
      const adapterBefore = adapterRegistry.get(botBefore.platformId)
      const grokAdapter = adapterBefore as
        | {
            listCachedAgents?: (accId: string) => Array<{
              id: string
              name: string
              avatarShape?: string
              avatarColor?: string
            }>
            bindConversationAgent?: (c: string, a: string, accId?: string) => void
          }
        | undefined
      const matchedAgent = grokAdapter?.listCachedAgents?.(botBefore.activeAccountId)?.find((a) => a.id === trimmed)
      const prevAgentId = botBefore.selectedAgentId
      const changed = prevAgentId !== trimmed
      if (changed) transcriptTransitions.delete(botId)
      const nextBot = {
        ...botBefore,
        selectedAgentId: trimmed,
        ...(prevAgentId && changed ? { activeSessionId: undefined } : {}),
        ...(matchedAgent?.avatarShape ? { avatarShape: matchedAgent.avatarShape } : {}),
        ...(matchedAgent?.avatarColor ? { avatarColor: matchedAgent.avatarColor } : {}),
        ...(botBefore.name === 'Grok Bot' && matchedAgent?.name ? { name: matchedAgent.name } : {})
      }
      if (!shallow(botBefore, nextBot)) {
        set((s) => ({
          ...(changed ? clearedSession(s, botBefore) : {}),
          bots: s.bots.map((b) => b.id === botId ? nextBot : b),
          ...(prevAgentId && changed ? {
            messages: {
              ...s.messages,
              [botId]: (s.messages[botId] ?? []).filter((m) => m.accountId === botBefore.activeAccountId && m.agentId === trimmed)
            }
          } : {})
        }))
      }
      try {
        const bot = get().bots.find((b) => b.id === botId)
        if (!bot) return
        grokAdapter?.bindConversationAgent?.(botId, trimmed, bot.activeAccountId)
        const bridge = electronBridge()
        if (bot.platformId === 'grok' && bridge?.grok?.rpc) {
          void bridge.grok
            .rpc({
              accountId: bot.activeAccountId,
              op: 'listTranscriptEntries',
              agentId: trimmed,
              sessionId: bot.activeSessionId ?? '',
              limit: 60
            })
            .then((res) => {
              if (!isCurrentSession(bot, selection)) return
              if (!res.ok || !res.data || typeof res.data !== 'object') return
              const root = res.data as Record<string, unknown>
              // Prefer pre-decoded, chronological `hydrated` array with presigned media URLs from main
              if (Array.isArray(root['hydrated'])) {
                const hydrated: ChatMessage[] = (
                  root['hydrated'] as Array<Record<string, unknown>>
                ).map((item, idx) => ({
                  id: String(item['id'] ?? `grok_h_${idx}`),
                  botId,
                  accountId: bot.activeAccountId,
                  agentId: trimmed,
                  role: item['role'] === 'user' ? 'user' : 'bot',
                  text: String(item['text'] ?? ''),
                  createdAt: Number(item['createdAt'] ?? Date.now()) || Date.now(),
                  delivery: item['role'] === 'user' ? 'sent' : undefined,
                  ...(Array.isArray(item['widgets'])
                    ? { widgets: item['widgets'] as ChatMessage['widgets'] }
                    : {}),
                  ...(Array.isArray(item['richWidgets'])
                    ? { richWidgets: item['richWidgets'] as ChatMessage['richWidgets'] }
                    : {}),
                  ...(Array.isArray(item['media'])
                    ? { media: item['media'] as ChatMessage['media'] }
                    : {}),
                  ...(Array.isArray(item['tools'])
                    ? { tools: item['tools'] as ChatMessage['tools'] }
                    : {})
                }))
                set((s) => ({
                  accounts: applyAccountLive(s.accounts, bot.activeAccountId, 'online', ['offline', 'error']),
                  messages: {
                    ...s.messages,
                    [botId]:
                      hydrated.length === 0
                        ? (s.messages[botId] ?? []).filter(
                            (m) => !m.agentId || m.agentId === trimmed
                          )
                        : mergeHydratedMessages(s.messages[botId] ?? [], hydrated)
                  }
                }))
              }
            })
            .catch(() => undefined)
        } else if (bot.platformId === 'cue' && bridge?.cue?.rpc) {
          void hydrateCueHistoryForBot(bot.activeAccountId, bot)
        }
      } catch {
        /* ignore */
      }
    },

    renameAccount: (accountId, displayName) => {
      const trimmed = displayName.trim()
      if (!trimmed) return
      patchAccount(accountId, { displayName: trimmed, label: trimmed })
    },

    signOutAccount: async (accountId) => {
      const account = get().accounts[accountId]
      if (!account) return
      invalidateAccount(accountId)
      await cleanupAccount(account)
    },

    removeAndClearAccount: async (botId, accountId) => {
      get().removeAccountFromBot(botId, accountId)
      if (get().bots.some((b) => b.accountIds.includes(accountId))) return
      await get().removeOrphanedAccount(accountId)
    },

    removeOrphanedAccount: async (accountId) => {
      const account = get().accounts[accountId]
      if (!account || get().bots.some((b) => b.accountIds.includes(accountId))) return
      invalidateAccount(accountId)
      const cleanup = cleanupAccount(account)
      set((state) => ({ accounts: omitKey(state.accounts, accountId), activity: omitKey(state.activity, accountId) }))
      flushWorkspacePersistence()
      await cleanup
    },

    setAccountStatus: (accountId, status, detail) => patchAccount(accountId, { status, statusDetail: detail }),

    connectAccount: async (accountId) => {
      const account = get().accounts[accountId]
      const adapter = account && adapterRegistry.get(account.platformId)
      if (!account || !adapter || account.pending || credentialCleanup ||
          accountCleanup.has(accountId) || accountConnections.has(accountId)) return
      const isCurrent = watchAccount(accountId)
      const connection: { transport?: Promise<ConnectionStatus> } = {}
      accountConnections.set(accountId, connection)
      patchAccount(accountId, { pending: true, statusDetail: account.platformId === 'hark' ? '正在验证 Hark 会话…' : account.statusDetail })
      try {
        if (!isCurrent()) return
        connection.transport = adapter.connect(accountId)
        const status = await connection.transport
        if (!isCurrent()) return
        const isLive = status === 'online' || status === 'busy' || status === 'attention'
        patchAccount(accountId, {
          status,
          statusDetail: isLive ? undefined : get().accounts[accountId]?.statusDetail
        })
        if (account.platformId === 'hark' && isLive) {
          const bridge = electronBridge()
          void bridge?.hark
            ?.authStatus?.(accountId)
            .then((st) => {
              if (isCurrent() && (st.handle || st.displayName)) {
                patchAccount(accountId, {
                  handle: st.handle || get().accounts[accountId]?.handle || account.handle,
                  displayName: st.displayName || get().accounts[accountId]?.displayName || account.displayName
                })
              }
            })
            .catch(() => undefined)
          const bot = get().bots.find((b) => b.activeAccountId === accountId)
          const selection = bot && sessionSelections.get(bot.id)
          if (bot && (!selection || pendingHarkSelections.get(bot.id) !== selection)) {
            void loadHarkSession(bot, bot.activeSessionId, selection).catch((error) => {
              if (isCurrent()) patchAccount(accountId, { statusDetail: errorMessage(error) })
            })
          }
        } else if (account.platformId === 'antigravity' && isLive) {
          const bridge = electronBridge()
          void bridge?.antigravity
            ?.authStatus?.(accountId)
            .then((st) => {
              if (isCurrent() && (st.handle || st.displayName)) {
                patchAccount(accountId, {
                  handle: st.handle || get().accounts[accountId]?.handle || account.handle,
                  displayName: st.displayName || get().accounts[accountId]?.displayName || account.displayName
                })
              }
            })
            .catch(() => undefined)
        } else if (account.platformId === 'dot' && status === 'online') {
          const bridge = electronBridge()
          const ownerBot =
            get().bots.find((b) => b.activeAccountId === accountId) ??
            get().bots.find((b) => b.accountIds.includes(accountId))
          if (ownerBot && bridge?.dot?.rpc) {
            void bridge.dot
              .authStatus(accountId)
              .then((st) => {
                if (isCurrent() && (st.handle || st.displayName)) {
                  patchAccount(accountId, {
                    handle: st.handle || account.handle,
                    displayName: st.displayName || account.displayName
                  })
                }
              })
              .catch(() => undefined)
            void bridge.dot
              .rpc({ accountId, op: 'listRoomMessages', limit: 32 })
              .then((res) => {
                if (!isCurrent() || !res.ok || !res.data || typeof res.data !== 'object') return
                const d = res.data as {
                  roomId?: string
                  dotId?: string
                  messages?: Array<{
                    id: string
                    role: 'user' | 'bot'
                    text: string
                    createdAtMs: number
                    media?: ChatMessage['media']
                  }>
                }
                if (d.roomId) {
                  patchBot(ownerBot.id, () => ({ activeSessionId: d.roomId }))
                }
                if (Array.isArray(d.messages) && d.messages.length > 0) {
                  const hydrated: ChatMessage[] = d.messages
                    .filter((m) => (m.text && m.text.trim()) || (m.media && m.media.length > 0))
                    .map((m) => ({
                      id: normalizeDotMsgId(m.id, m.role),
                      botId: ownerBot.id,
                      accountId,
                      role: m.role,
                      text: (m.text || '').trim(),
                      createdAt: m.createdAtMs || Date.now(),
                      delivery: m.role === 'user' ? 'sent' : undefined,
                      ...(m.media && m.media.length > 0 ? { media: m.media } : {})
                    }))
                  if (hydrated.length > 0) {
                    set((s) => ({
                      messages: {
                        ...s.messages,
                        [ownerBot.id]: mergeHydratedMessages(s.messages[ownerBot.id] ?? [], hydrated)
                      }
                    }))
                  }
                }
              })
              .catch(() => undefined)
          }
        } else if (account.platformId === 'grok' && (status === 'online' || status === 'busy')) {
          const bridge = electronBridge()
          void bridge?.grok
            ?.authStatus(accountId)
            .then((st) => {
              if (isCurrent() && st.accountSlot) {
                const latestAcc = get().accounts[accountId]
                patchAccount(accountId, {
                  handle: st.accountSlot,
                  displayName: latestAcc?.label || st.accountSlot
                })
              }
            })
            .catch(() => undefined)
          await get().syncGrokAccountBots(accountId)
        } else if (account.platformId === 'cue' && (status === 'online' || status === 'busy')) {
          await get().syncCueAccountBots(accountId)
        }
      } catch (error) {
        if (isCurrent()) patchAccount(accountId, { status: 'error', statusDetail: errorMessage(error) })
      } finally {
        if (accountConnections.get(accountId) === connection) {
          accountConnections.delete(accountId)
          if (!accountCleanup.has(accountId)) patchAccount(accountId, { pending: false })
        }
      }
    },

    openMuseLogin: async (accountId) => {
      const account = get().accounts[accountId]
      const adapter = account && adapterRegistry.get(account.platformId)
      if (!account || !adapter || account.pending) return
      if (account.platformId !== 'meta-muse' || !adapter.openLogin) {
        await get().connectAccount(accountId)
        return
      }
      const bot = get().bots.find((b) => b.accountIds.includes(accountId))
      patchAccount(accountId, { pending: true, statusDetail: '等待在登录窗口完成…' })
      try {
        const status = await adapter.openLogin(accountId, bot?.id)
        patchAccount(accountId, {
          status,
          statusDetail:
            status === 'offline'
              ? '在弹出的窗口里完成 Muse 登录'
              : status === 'error'
                ? get().accounts[accountId]?.statusDetail
                : undefined
        })
      } catch (error) {
        patchAccount(accountId, { status: 'error', statusDetail: errorMessage(error) })
      } finally {
        patchAccount(accountId, { pending: false })
      }
    },

    openGrokLogin: async (accountId, openInBrowser = false) => {
      const account = get().accounts[accountId]
      const adapter = account && adapterRegistry.get(account.platformId)
      if (!account || !adapter || account.pending) return
      if (account.platformId !== 'grok') {
        await get().connectAccount(accountId)
        return
      }
      const bot = get().bots.find((b) => b.accountIds.includes(accountId))
      patchAccount(accountId, {
        pending: true,
        statusDetail: openInBrowser ? '请在浏览器完成 Grok Bot 授权确认…' : '请在弹出的窗口完成 Grok Bot 登录…'
      })
      try {
        const bridge = electronBridge()
        if (bridge?.grok?.openLogin) {
          await bridge.grok.openLogin({ accountId, openInBrowser })
        } else if (adapter.openLogin) {
          await adapter.openLogin(accountId, bot?.id)
        }
        patchAccount(accountId, { pending: false })
        const latest = get().accounts[accountId]
        const authSt = await bridge?.grok?.authStatus?.(accountId).catch(() => null)
        if (authSt?.signedIn) {
          const nextStatus: ConnectionStatus =
            latest?.status === 'busy' || latest?.status === 'attention' ? latest.status : 'online'
          patchAccount(accountId, {
            pending: false,
            status: nextStatus,
            statusDetail: undefined,
            ...(authSt.accountSlot
              ? {
                  handle: authSt.accountSlot,
                  displayName: latest?.label || authSt.accountSlot
                }
              : {})
          })
          void get().connectAccount(accountId)
        } else if (
          latest?.status === 'online' ||
          latest?.status === 'busy' ||
          latest?.status === 'attention'
        ) {
          patchAccount(accountId, { pending: false })
        } else {
          patchAccount(accountId, {
            pending: false,
            status: 'offline',
            statusDetail: openInBrowser
              ? '已在默认浏览器打开授权页，点击确认后自动同步全部 Bot'
              : '在弹出的窗口完成登录，成功后自动同步账号下全部 Bot'
          })
        }
      } catch (error) {
        patchAccount(accountId, { status: 'error', statusDetail: errorMessage(error), pending: false })
      } finally {
        if (get().accounts[accountId]?.pending) {
          patchAccount(accountId, { pending: false })
        }
      }
    },

    syncGrokAccountBots: async (accountId, opts) => {
      if (accountCleanup.has(accountId) || credentialCleanup) return 0
      const isCurrent = watchAccount(accountId)
      const adapter = adapterRegistry.get('grok') as
        | {
            connect?: (id: string) => Promise<ConnectionStatus>
            refreshAgents?: (id: string) => Promise<
              Array<{
                id: string
                name: string
                description?: string
                avatarShape?: string
                avatarColor?: string
              }>
            >
            listCachedAgents?: (id: string) => Array<{
              id: string
              name: string
              description?: string
              avatarShape?: string
              avatarColor?: string
            }>
            bindConversationAgent?: (convId: string, agentId: string, accId?: string) => void
          }
        | undefined
      if (!adapter) return 0

      // Materialize account if syncing straight from AddBotDialog before `addBot` ran
      if (!get().accounts[accountId]) {
        const bridge = electronBridge()
        const authSt = await bridge?.grok?.authStatus?.(accountId).catch(() => null)
        if (!isCurrent()) return 0
        const slot = authSt?.accountSlot || ''
        set((s) => ({
          accounts: {
            ...s.accounts,
            [accountId]: {
              id: accountId,
              platformId: 'grok',
              displayName: slot || 'Grok Bot',
              handle: slot,
              status: authSt?.signedIn ? 'online' : 'offline'
            }
          }
        }))
        await adapter.connect?.(accountId).catch(() => undefined)
        if (!isCurrent()) return 0
      }

      if (opts?.includeDismissed) {
        set((s) => {
          if (!s.dismissedGrokAgents[accountId]) return s
          const { [accountId]: _cleared, ...rest } = s.dismissedGrokAgents
          return { dismissedGrokAgents: rest }
        })
      }

      let agents = adapter.listCachedAgents?.(accountId) ?? []
      if (agents.length === 0 && adapter.refreshAgents) {
        agents = await adapter.refreshAgents(accountId).catch(() => [])
      }

      const authSt =
        agents.length > 0
          ? null
          : await electronBridge()?.grok?.authStatus?.(accountId).catch(() => null)
      if (!isCurrent()) return 0
      const currentAcc = get().accounts[accountId]
      if (currentAcc && (agents.length > 0 || authSt?.signedIn)) {
        const patch: Partial<BotAccount> = {}
        if (currentAcc.status === 'offline' || currentAcc.status === 'error') {
          patch.status = 'online'
          patch.statusDetail = undefined
        }
        if (authSt?.accountSlot && !currentAcc.handle) {
          patch.handle = authSt.accountSlot
          patch.displayName = currentAcc.label || authSt.accountSlot
        }
        if (Object.keys(patch).length > 0) {
          patchAccount(accountId, patch)
        }
      }

      const state = get()
      const dismissed = new Set(
        opts?.includeDismissed ? [] : (state.dismissedGrokAgents[accountId] ?? [])
      )
      const visibleAgents = agents.filter((a) => !dismissed.has(a.id))
      const allAgentIds = new Set(agents.map((a) => a.id))

      let groups = state.groups
      const existingForAccount = state.bots.filter(
        (b) => b.platformId === 'grok' && b.accountIds.includes(accountId)
      )
      const selectedGroup = state.bots.find((b) => b.id === state.selectedBotId)?.groupId
      let targetGroupId =
        opts?.preferredGroupId ??
        existingForAccount[0]?.groupId ??
        selectedGroup ??
        groups[0]?.id ??
        createId('grp')
      if (!groups.some((g) => g.id === targetGroupId)) {
        groups = [...groups, { id: targetGroupId, name: 'Workspace' }]
      }

      // Brand-new Grok account with 0 server agents yet: ensure at least 1 placeholder Bot row
      if (visibleAgents.length === 0) {
        if (existingForAccount.length === 0 && agents.length === 0) {
          const placeholderId = createId('bot')
          const acc = get().accounts[accountId]
          const bot: Bot = {
            id: placeholderId,
            name: acc?.handle ? `Grok · ${acc.handle}` : 'Grok Bot',
            emoji: '🤖',
            description: '',
            platformId: 'grok',
            groupId: targetGroupId,
            accountIds: [accountId],
            activeAccountId: accountId,
            memory: [],
            notes: '',
            createdAt: Date.now(),
            unread: 0
          }
          set((s) => ({
            groups,
            bots: [...s.bots, bot],
            messages: { ...s.messages, [bot.id]: s.messages[bot.id] ?? [] },
            selectedBotId: opts?.selectFirst || !s.selectedBotId ? bot.id : s.selectedBotId,
            collapsedGroups: { ...s.collapsedGroups, [targetGroupId]: false }
          }))
          return 1
        }
        return existingForAccount.length
      }

      // Match or create one sidebar Bot per Grok Agent
      const claimedBotIds = new Set<string>()
      const botsToHydrate: Array<{ botId: string; agentId: string }> = []
      let nextBots = [...state.bots]
      const nextMessages = { ...state.messages }

      const isGenericGrokName = (name: string) =>
        /^Grok(?:\s+Bot)?(?:\s+\d+)?$/i.test(name.trim())

      const otherGrokNames = new Set(
        nextBots
          .filter((b) => b.platformId === 'grok' && !b.accountIds.includes(accountId))
          .map((b) => b.name.trim().toLowerCase())
      )
      const ownerAcc = get().accounts[accountId]
      const accountSuffix = ownerAcc?.handle || accountId.slice(-4)
      const disambiguateGrokBotName = (rawName: string): string => {
        const base = rawName.trim() || 'Grok Bot'
        if (!otherGrokNames.has(base.toLowerCase())) return base
        return uniqueBotName(nextBots, `${base} (${accountSuffix})`)
      }

      // Pass 1: exact selectedAgentId matches
      const unmatchedAgents: typeof visibleAgents = []
      for (const agent of visibleAgents) {
        const exactIdx = nextBots.findIndex(
          (b) =>
            b.platformId === 'grok' &&
            b.accountIds.includes(accountId) &&
            b.selectedAgentId === agent.id &&
            !claimedBotIds.has(b.id)
        )
        if (exactIdx >= 0) {
          const prev = nextBots[exactIdx]!
          claimedBotIds.add(prev.id)
          nextBots[exactIdx] = {
            ...prev,
            name:
              isGenericGrokName(prev.name) && agent.name
                ? disambiguateGrokBotName(agent.name)
                : prev.name,
            description: agent.description ?? prev.description,
            ...(agent.avatarShape ? { avatarShape: agent.avatarShape } : {}),
            ...(agent.avatarColor ? { avatarColor: agent.avatarColor } : {})
          }
          adapter.bindConversationAgent?.(prev.id, agent.id, accountId)
        } else {
          unmatchedAgents.push(agent)
        }
      }

      // Pass 2: bind unbound/stale placeholder bots first, then create dedicated Bots for remaining agents
      for (const agent of unmatchedAgents) {
        const placeholderIdx = nextBots.findIndex(
          (b) =>
            b.platformId === 'grok' &&
            b.accountIds.includes(accountId) &&
            !claimedBotIds.has(b.id) &&
            (!b.selectedAgentId || !allAgentIds.has(b.selectedAgentId))
        )
        if (placeholderIdx >= 0) {
          const prev = nextBots[placeholderIdx]!
          claimedBotIds.add(prev.id)
          nextBots[placeholderIdx] = {
            ...prev,
            name: agent.name ? disambiguateGrokBotName(agent.name) : prev.name,
            selectedAgentId: agent.id,
            description: agent.description ?? prev.description,
            ...(agent.avatarShape ? { avatarShape: agent.avatarShape } : {}),
            ...(agent.avatarColor ? { avatarColor: agent.avatarColor } : {})
          }
          botsToHydrate.push({ botId: prev.id, agentId: agent.id })
        } else {
          const newBotId = createId('bot')
          claimedBotIds.add(newBotId)
          const newBot: Bot = {
            id: newBotId,
            name: disambiguateGrokBotName(agent.name || 'Grok Bot'),
            emoji: '🤖',
            ...(agent.avatarShape ? { avatarShape: agent.avatarShape } : {}),
            ...(agent.avatarColor ? { avatarColor: agent.avatarColor } : {}),
            selectedAgentId: agent.id,
            description: agent.description ?? '',
            platformId: 'grok',
            groupId: targetGroupId,
            accountIds: [accountId],
            activeAccountId: accountId,
            memory: [],
            notes: '',
            createdAt: Date.now(),
            unread: 0
          }
          nextBots.push(newBot)
          nextMessages[newBotId] = nextMessages[newBotId] ?? []
          botsToHydrate.push({ botId: newBotId, agentId: agent.id })
        }
      }

      const accountBots = nextBots.filter(
        (b) => b.platformId === 'grok' && b.accountIds.includes(accountId)
      )
      const firstAccountBot = accountBots[0]
      const nextSelectedId =
        opts?.selectFirst && firstAccountBot
          ? firstAccountBot.id
          : state.selectedBotId ?? firstAccountBot?.id ?? null

      set((s) => ({
        groups,
        bots: nextBots,
        messages: nextMessages,
        selectedBotId: nextSelectedId,
        collapsedGroups: { ...s.collapsedGroups, [targetGroupId]: false }
      }))

      // Hydrate newly bound bots + the currently selected Grok bot
      const hydrateSet = new Map<string, string>()
      for (const item of botsToHydrate) hydrateSet.set(item.botId, item.agentId)
      const activeSelected = get().bots.find((b) => b.id === get().selectedBotId)
      if (
        activeSelected &&
        activeSelected.platformId === 'grok' &&
        activeSelected.accountIds.includes(accountId) &&
        activeSelected.selectedAgentId
      ) {
        hydrateSet.set(activeSelected.id, activeSelected.selectedAgentId)
      }
      for (const [bId, agId] of hydrateSet.entries()) {
        get().setSelectedAgent(bId, agId)
      }

      return accountBots.length
    },

    openHarkLogin: async (accountId) => {
      const account = get().accounts[accountId]
      const adapter = account && adapterRegistry.get(account.platformId)
      if (!account || !adapter || account.pending) return
      if (account.platformId !== 'hark' || !adapter.openLogin) {
        await get().connectAccount(accountId)
        return
      }
      const bot = get().bots.find((b) => b.accountIds.includes(accountId))
      patchAccount(accountId, { pending: true, statusDetail: '在弹出的窗口完成 Hark 登录…' })
      try {
        const status = await adapter.openLogin(accountId, bot?.id)
        patchAccount(accountId, {
          status,
          statusDetail:
            status === 'offline'
              ? '在弹出的窗口完成 Hark 登录'
              : status === 'error'
                ? get().accounts[accountId]?.statusDetail
                : undefined
        })
      } catch (error) {
        patchAccount(accountId, { status: 'error', statusDetail: errorMessage(error) })
      } finally {
        patchAccount(accountId, { pending: false })
      }
    },

    openDotLogin: async (accountId) => {
      const account = get().accounts[accountId]
      const adapter = account && adapterRegistry.get(account.platformId)
      if (!account || !adapter || account.pending) return
      if (account.platformId !== 'dot' || !adapter.openLogin) {
        await get().connectAccount(accountId)
        return
      }
      const bot = get().bots.find((b) => b.accountIds.includes(accountId))
      patchAccount(accountId, { pending: true, statusDetail: '在弹出的窗口完成 ChatGPT Dot 登录…' })
      try {
        const status = await adapter.openLogin(accountId, bot?.id)
        patchAccount(accountId, {
          status,
          statusDetail:
            status === 'offline'
              ? '在弹出的窗口完成 ChatGPT 登录或导入凭据'
              : status === 'error'
                ? get().accounts[accountId]?.statusDetail
                : undefined
        })
      } catch (error) {
        patchAccount(accountId, { status: 'error', statusDetail: errorMessage(error) })
      } finally {
        patchAccount(accountId, { pending: false })
      }
    },

    openAntigravityLogin: async (accountId) => {
      const account = get().accounts[accountId]
      const adapter = account && adapterRegistry.get(account.platformId)
      if (!account || !adapter || account.pending) return
      if (account.platformId !== 'antigravity' || !adapter.openLogin) {
        await get().connectAccount(accountId)
        return
      }
      const bot = get().bots.find((b) => b.accountIds.includes(accountId))
      patchAccount(accountId, { pending: true, statusDetail: '在弹出的窗口完成 Google Antigravity 登录…' })
      try {
        const status = await adapter.openLogin(accountId, bot?.id)
        patchAccount(accountId, {
          status,
          statusDetail:
            status === 'offline'
              ? '在弹出的窗口完成 Google Antigravity 登录'
              : status === 'error'
                ? get().accounts[accountId]?.statusDetail
                : undefined
        })
      } catch (error) {
        patchAccount(accountId, { status: 'error', statusDetail: errorMessage(error) })
      } finally {
        patchAccount(accountId, { pending: false })
      }
    },

    openCueLogin: async (accountId, openInBrowser = false) => {
      const account = get().accounts[accountId]
      const adapter = account && adapterRegistry.get(account.platformId)
      if (!account || !adapter || account.pending || credentialCleanup || accountCleanup.has(accountId)) return
      if (account.platformId !== 'cue') {
        await get().connectAccount(accountId)
        return
      }
      patchAccount(accountId, {
        pending: true,
        statusDetail: openInBrowser ? '请在浏览器完成 Cue 登录授权…' : '请在弹出的窗口完成 Cue 登录…'
      })
      const isCurrent = watchAccount(accountId)
      try {
        const bridge = electronBridge()
        if (bridge?.cue?.openLogin) {
          await bridge.cue.openLogin({ accountId, openInBrowser })
        } else if (adapter.openLogin) {
          await adapter.openLogin(accountId)
        }
        if (!isCurrent()) return
        patchAccount(accountId, { pending: false })
        const authSt = await bridge?.cue?.authStatus?.(accountId).catch(() => null)
        if (isCurrent() && authSt?.signedIn) {
          patchAccount(accountId, {
            pending: false,
            status: 'online',
            statusDetail: undefined,
            ...(authSt.handle ? { handle: authSt.handle, displayName: account.label || authSt.displayName || authSt.handle } : {})
          })
          await get().syncCueAccountBots(accountId)
        }
      } catch (error) {
        if (isCurrent()) patchAccount(accountId, { status: 'error', statusDetail: errorMessage(error), pending: false })
      } finally {
        if (isCurrent() && get().accounts[accountId]?.pending) {
          patchAccount(accountId, { pending: false })
        }
      }
    },

    importCueCredentials: async (accountId, credential) => {
      const bridge = electronBridge()
      if (!bridge?.cue?.importCredentials) {
        throw new Error('Cue IPC unavailable')
      }
      if (credentialCleanup || accountCleanup.has(accountId)) throw new Error('Cue credentials are being cleared')
      const isCurrent = watchAccount(accountId)
      const cue = bridge.cue
      const previous = cueCredentialImports.get(accountId)
      const importing = (previous ?? Promise.resolve()).catch(() => undefined).then(() => {
        if (!isCurrent()) throw new Error('Cue account changed while importing credentials')
        return cue.importCredentials({ accountId, credential })
      })
      cueCredentialImports.set(accountId, importing)
      const st = await importing.finally(() => {
        if (cueCredentialImports.get(accountId) === importing) cueCredentialImports.delete(accountId)
      })
      if (!isCurrent()) return
      const handle = st.handle || st.accountSlot || ''
      set((s) => ({
        accounts: {
          ...s.accounts,
          [accountId]: {
            ...s.accounts[accountId],
            id: accountId,
            platformId: 'cue',
            displayName: s.accounts[accountId]?.label || st.displayName || handle || 'Cue',
            handle,
            status: st.signedIn ? 'online' : 'offline',
            statusDetail: undefined
          }
        }
      }))
      if (st.signedIn) {
        await get().syncCueAccountBots(accountId, { selectFirst: true })
      }
    },

    syncCueAccountBots: async (accountId, opts) => {
      const owner = get().accounts[accountId]
      const hadOwner = Boolean(owner)
      if (
        (owner && owner.platformId !== 'cue') ||
        (!owner && accountGenerations.has(accountId)) ||
        credentialCleanup ||
        accountCleanup.has(accountId)
      ) {
        return 0
      }
      const isCurrent = watchAccount(accountId)
      const rosterGeneration = cueRosterGenerations.get(accountId)
      const isRosterCurrent = () => isCurrent() && cueRosterGenerations.get(accountId) === rosterGeneration
      const rosterSelections = new Map(get().bots.filter((b) => b.accountIds.includes(accountId)).map((b) => [
        b.id, { bot: b, selection: sessionSelections.get(b.id) }
      ]))
      const bridge = electronBridge()
      const authSt = await bridge?.cue?.authStatus?.(accountId).catch(() => null)
      const sessionSt = !authSt ? await bridge?.cue?.getSession?.(accountId).catch(() => null) : null
      const handle = (authSt?.handle || authSt?.accountSlot || sessionSt?.handle || sessionSt?.accountSlot || '').trim()
      const signedIn = Boolean(authSt?.signedIn ?? sessionSt?.signedIn ?? true)

      if (!isRosterCurrent()) return 0

      let agents: Array<{ id: string; name: string; description?: string; sessionId?: string }> = []
      if (bridge?.cue?.rpc) {
        const res = await bridge.cue.rpc({ accountId, op: 'listAgents' }).catch(() => null)
        if (res?.ok && res.data) {
          const rawList = Array.isArray(res.data)
            ? res.data
            : typeof res.data === 'object' && Array.isArray((res.data as Record<string, unknown>)['agents'])
              ? ((res.data as Record<string, unknown>)['agents'] as unknown[])
              : []
          for (const item of rawList) {
            if (!item || typeof item !== 'object') continue
            const rec = item as Record<string, unknown>
            const id = String(rec['id'] ?? rec['agentId'] ?? '').trim()
            if (!id) continue
            const sessionRaw = rec['sessionId'] ?? rec['sessionUid'] ?? rec['session_uid']
            const sessionId = typeof sessionRaw === 'string' && sessionRaw.trim() ? sessionRaw.trim() : undefined
            agents.push({
              id,
              name: String(rec['name'] ?? rec['title'] ?? 'Cue').trim() || 'Cue',
              description: typeof rec['description'] === 'string' ? rec['description'] : undefined,
              ...(sessionId ? { sessionId } : {})
            })
          }
        }
      }

      if (agents.length === 0) {
        agents = [{ id: `cue_default_${accountId}`, name: 'Cue' }]
      }

      const state = get()
      const currentAccount = state.accounts[accountId]
      if (
        !isRosterCurrent() ||
        (currentAccount && currentAccount.platformId !== 'cue') ||
        (hadOwner && !currentAccount) ||
        accountCleanup.has(accountId)
      ) {
        return 0
      }
      let groups = state.groups
      const existingForAccount = state.bots.filter(
        (b) => b.platformId === 'cue' && b.accountIds.includes(accountId)
      )
      const targetGroupId =
        opts?.preferredGroupId ??
        existingForAccount[0]?.groupId ??
        state.groups[0]?.id ??
        createId('grp')
      if (!groups.some((g) => g.id === targetGroupId)) {
        groups = [...groups, { id: targetGroupId, name: 'Workspace' }]
      }

      let nextBots = [...state.bots]
      const nextMessages = { ...state.messages }
      let nextState = state
      const claimedIds = new Set<string>()
      const incomingAgentIds = new Set(agents.map((a) => a.id))
      const isPlaceholderAgentId = (id: string | undefined): boolean =>
        !id || id === 'agent-default' || id.startsWith('cue_default_')

      const buildCueBotName = (agentName: string): string => {
        const cleanAgent = agentName.trim()
        const isGeneric = !cleanAgent || /^cue(?:\s+bot)?$/i.test(cleanAgent)
        let base: string
        if (handle) {
          base = isGeneric ? `Cue · ${handle}` : `Cue · ${cleanAgent} (${handle})`
        } else {
          base = isGeneric ? 'Cue' : `Cue · ${cleanAgent}`
        }
        return uniqueBotName(nextBots, base)
      }

      for (const agent of agents) {
        let existingIdx = nextBots.findIndex(
          (b) =>
            b.platformId === 'cue' &&
            b.accountIds.includes(accountId) &&
            !claimedIds.has(b.id) &&
            b.selectedAgentId === agent.id
        )
        if (existingIdx < 0) {
          existingIdx = nextBots.findIndex(
            (b) =>
              b.platformId === 'cue' &&
              b.accountIds.includes(accountId) &&
              !claimedIds.has(b.id) &&
              isPlaceholderAgentId(b.selectedAgentId) &&
              !incomingAgentIds.has(b.selectedAgentId ?? '')
          )
        }
        if (existingIdx >= 0) {
          const prev = nextBots[existingIdx]!
          claimedIds.add(prev.id)
          const others = nextBots.filter((_, i) => i !== existingIdx)
          const cleanAgent = agent.name.trim()
          const hasNamedAgent = Boolean(cleanAgent && !/^cue(?:\s+bot)?$/i.test(cleanAgent))
          const isPlaceholderUpgrade =
            isPlaceholderAgentId(prev.selectedAgentId) &&
            !isPlaceholderAgentId(agent.id) &&
            hasNamedAgent &&
            /^cue(?:\s*·|\s+\d+)?(?:\s+.*)?$/i.test(prev.name.trim())
          const needsRename =
            /^cue(?:\s+\d+)?$/i.test(prev.name.trim()) ||
            isPlaceholderUpgrade ||
            others.some((o) => o.name.trim().toLowerCase() === prev.name.trim().toLowerCase())
          const preferredName = isPlaceholderUpgrade
            ? (handle ? `Cue · ${cleanAgent} (${handle})` : `Cue · ${cleanAgent}`)
            : (handle ? `Cue · ${handle}` : prev.name)
          const rosterSelection = rosterSelections.get(prev.id)
          const ownsSelection = rosterSelection && isCurrentSession(rosterSelection.bot, rosterSelection.selection)
          const selectedAgentId = ownsSelection && prev.activeAccountId === accountId ? agent.id : prev.selectedAgentId
          const activeSessionId = ownsSelection && prev.activeAccountId === accountId
            ? agent.sessionId ?? prev.activeSessionId : prev.activeSessionId
          if (prev.selectedAgentId !== selectedAgentId || prev.activeSessionId !== activeSessionId) {
            markSessionSelection(prev.id)
            transcriptTransitions.delete(prev.id)
            nextState = { ...nextState, ...clearedSession(nextState, prev) }
            const changedSession = prev.activeSessionId && prev.activeSessionId !== activeSessionId
            nextMessages[prev.id] = changedSession ? [] : (nextMessages[prev.id] ?? []).filter(
              (m) => m.accountId === accountId && (!m.agentId || m.agentId === selectedAgentId)
            )
          }
          nextBots[existingIdx] = {
            ...prev,
            name: needsRename ? uniqueBotName(others, preferredName) : prev.name,
            selectedAgentId,
            activeSessionId,
            description: agent.description ?? prev.description
          }
        } else {
          const newBotId = createId('bot')
          claimedIds.add(newBotId)
          const newBot: Bot = {
            id: newBotId,
            name: buildCueBotName(agent.name),
            emoji: '✨',
            selectedAgentId: agent.id,
            ...(agent.sessionId ? { activeSessionId: agent.sessionId } : {}),
            description: agent.description ?? '',
            platformId: 'cue',
            groupId: targetGroupId,
            accountIds: [accountId],
            activeAccountId: accountId,
            memory: [],
            notes: '',
            createdAt: Date.now(),
            unread: 0
          }
          nextBots.push(newBot)
          nextMessages[newBotId] = nextMessages[newBotId] ?? []
        }
      }

      const accountBots = nextBots.filter(
        (b) => b.platformId === 'cue' && b.accountIds.includes(accountId)
      )
      set((s) => {
        const nextSelectedId =
          opts?.selectFirst && accountBots[0]
            ? accountBots[0].id
            : (s.selectedBotId ?? accountBots[0]?.id ?? null)
        const switchedSelection = nextSelectedId !== s.selectedBotId
        const rememberedMap =
          switchedSelection && s.selectedBotId
            ? { ...(s.webSessionByBot ?? {}), [s.selectedBotId]: s.webSessionOpen }
            : (s.webSessionByBot ?? {})
        return {
          groups,
          bots: nextBots,
          typing: nextState.typing,
          activity: nextState.activity,
          replyingTo: nextState.replyingTo,
          chatActionErrors: nextState.chatActionErrors,
          accounts: {
            ...nextState.accounts,
            [accountId]: {
              ...currentAccount,
              id: accountId,
              platformId: 'cue',
              displayName: currentAccount?.label || authSt?.displayName || handle || currentAccount?.displayName || 'Cue',
              handle: handle || currentAccount?.handle || '',
              status: signedIn ? 'online' : (currentAccount?.status ?? 'offline')
            }
          },
          messages: nextMessages,
          selectedBotId: nextSelectedId,
          webSessionOpen: switchedSelection ? Boolean(nextSelectedId && rememberedMap[nextSelectedId]) : s.webSessionOpen,
          webSessionByBot: rememberedMap,
          webSessionTargetUrl: switchedSelection ? null : s.webSessionTargetUrl,
          collapsedGroups: { ...s.collapsedGroups, [targetGroupId]: false }
        }
      })

      if (bridge?.cue?.rpc) {
        for (const bot of accountBots) {
          void hydrateCueHistoryForBot(accountId, bot)
        }
      }

      return accountBots.length
    },

    trimIdleBots: (now = Date.now()) => {
      // The open bot may still carry a mark from an earlier run or an offline moment.
      const selected = get().selectedBotId
      if (selected) reloadTrimmedBot(selected)
      const state = get()
      const candidates = state.bots
        .filter((b) =>
          b.id !== state.selectedBotId &&
          now - (lastSeenAt.get(b.id) ?? startedAt) >= TRIM_IDLE_AFTER_MS &&
          canReloadHistory(b) &&
          !isBotBusy(state, b))
        .map((b) => b.id)
      const { messages, trimmed } = trimMessages(state.messages, candidates)
      if (trimmed.length === 0) return
      const trimmedBots = { ...state.trimmedBots }
      for (const id of trimmed) trimmedBots[id] = true
      set({ messages, trimmedBots })
    },

    hydrateCueBotHistory: async (botId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (!bot || bot.platformId !== 'cue' || !bot.activeAccountId) return 0
      return await hydrateCueHistoryForBot(bot.activeAccountId, bot)
    },

    setGrokAccessToken: async (accountId, accessToken, accountSlot, machineId, refreshToken) => {
      const existingAcc = get().accounts[accountId]
      if (existingAcc && existingAcc.platformId !== 'grok') return
      const adapter = adapterRegistry.get('grok')
      if (!adapter) return
      if (existingAcc) patchAccount(accountId, { pending: true })
      try {
        const bridge = electronBridge()
        let resolvedSlot = accountSlot
        if (accessToken?.trim() && bridge?.grok?.setAccessToken) {
          const st = await bridge.grok.setAccessToken({
            accountId,
            accessToken: accessToken.trim(),
            refreshToken,
            accountSlot,
            machineId
          })
          resolvedSlot = st.accountSlot ?? resolvedSlot
        }
        if (!get().accounts[accountId]) {
          // Only auto-materialize if explicitly importing a raw token (not during AddBotDialog waiting step)
          if (!accessToken?.trim()) return
          set((s) => ({
            accounts: {
              ...s.accounts,
              [accountId]: {
                id: accountId,
                platformId: 'grok',
                displayName: resolvedSlot || 'Grok Bot',
                handle: resolvedSlot || '',
                status: 'offline'
              }
            }
          }))
        } else if (resolvedSlot) {
          patchAccount(accountId, {
            handle: resolvedSlot,
            displayName: get().accounts[accountId]?.label || resolvedSlot
          })
        }
        const grok = adapter as {
          setAuth?: (s: {
            accountId: string
            signedIn?: boolean
            accountSlot?: string
            machineId?: string
          }) => void
        }
        grok.setAuth?.({ accountId, signedIn: true, accountSlot: resolvedSlot, machineId })
        patchAccount(accountId, { status: 'online', statusDetail: undefined, pending: false })
        await get().connectAccount(accountId)
        const postAcc = get().accounts[accountId]
        if (postAcc && (postAcc.status === 'offline' || postAcc.status === 'error')) {
          const authSt = await bridge?.grok?.authStatus?.(accountId).catch(() => null)
          if (authSt === null || authSt?.signedIn) {
            patchAccount(accountId, { status: 'online', statusDetail: undefined })
          }
        }
      } catch (error) {
        if (get().accounts[accountId]) {
          patchAccount(accountId, { status: 'error', statusDetail: errorMessage(error), pending: false })
        }
        throw error
      }
    },

    disconnectAccount: async (accountId) => {
      const account = get().accounts[accountId]
      const adapter = account && adapterRegistry.get(account.platformId)
      if (!account || !adapter || account.pending) return
      patchAccount(accountId, { pending: true })
      try {
        await adapter.disconnect(accountId)
        patchAccount(accountId, { status: 'offline', statusDetail: undefined })
      } catch (error) {
        patchAccount(accountId, { statusDetail: errorMessage(error) })
      } finally {
        patchAccount(accountId, { pending: false })
      }
    },

    clearAllCredentials: () => {
      if (credentialCleanup) return credentialCleanup
      const bridge = electronBridge()
      const allAccounts = Object.values(get().accounts)
      workspaceGeneration = Symbol()
      credentialCleanup = Promise.resolve().then(async () => {
        await Promise.all(allAccounts.map((acc) => get().signOutAccount(acc.id)))
        await Promise.allSettled(cueCredentialImports.values())
        await bridge?.dot?.clearAuth?.('*').catch(() => undefined)
        await bridge?.grok?.clearAuth?.('*').catch(() => undefined)
        await bridge?.cue?.clearAuth?.('*').catch(() => undefined)
        await bridge?.hermes?.clearAuth?.('*').catch(() => undefined)
        await bridge?.muse?.clearProxyPool?.().catch(() => undefined)
        await bridge?.vault?.clearAll?.().catch(() => undefined)
        try {
          if (typeof window !== 'undefined') window.localStorage.removeItem('bothub.dot.memorySnapshot')
        } catch {
          /* ignore */
        }
      }).finally(() => {
        credentialCleanup = undefined
        flushWorkspacePersistence()
      })
      return credentialCleanup
    },

    resetWorkspace: async () => {
      await get().clearAllCredentials()
      const fresh = createSeed()
      sessionSelections.clear()
      pendingHarkSelections.clear()
      transcriptTransitions.clear()
      accountGenerations.clear()
      cueRosterGenerations.clear()
      workspaceGeneration = Symbol()
      set({
        groups: fresh.groups,
        bots: fresh.bots,
        accounts: fresh.accounts,
        messages: fresh.messages,
        typing: {},
        activity: {},
        hermesSessionErrors: {},
        chatActionErrors: {},
        replyingTo: {},
        dismissedGrokAgents: {},
        webSessionByBot: {},
        webSessionOpen: false,
        webSessionTargetUrl: null,
        selectedBotId: null,
        collapsedGroups: {},
        trimmedBots: {}
      })
      flushWorkspacePersistence()
    }
  }
  },
  {
    name: 'bothub-workspace-v1',
    storage: workspaceStorage,
    // Nothing is in flight after a restart; drop stale `sending`/`pending`.
    merge: (persisted, current) => {
      const restored = { ...current, ...sanitizePersisted((persisted ?? {}) as Partial<BotHubState>) }
      return {
        ...restored,
        webSessionOpen: restored.selectedBotId ? restored.webSessionByBot[restored.selectedBotId] === true : false
      }
    },
    partialize: partializeWorkspace,
    onRehydrateStorage: () => (state) => {
      if (state) lastWorkspace = partializeWorkspace(state)
    }
  }
)
)
