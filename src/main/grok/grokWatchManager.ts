/**
 * Account-level persistent `WatchGrokBotTranscripts` multiplex manager for Grok Bot 0.79.3,
 * plus presigned attachment read cache (`ResolveGrokBotAttachmentReads`).
 *
 * Consumes all 12 server-streaming frame types from `WatchGrokBotTranscriptsResponse`:
 * - `rows` (entries + deletes + replay + multi-bubble assistant streaming)
 * - `agent_state` (`is_running`, `is_composing_message`, `activity`, `awaiting`, `has_running_subagents`)
 * - `turn_failed` (usage limits, rate limits, policy blocks, harness failures)
 * - `roster_changed` (real-time agent creation/edits/deletes/group changes)
 * - `box_state` (SandBox VM run state transitions)
 * - `page_title_changed` (AgentStore / Canvas document live updates)
 * - `cleared` (conversation reset / generation bump)
 * - `cursor_too_old` (automatic gap backfill via `ListGrokBotTranscriptEntries`)
 * - `absolute_lifetime_ms` (proactive reconnect before stream deadline)
 * - `ping` / `computer_actions` / `access_denied`
 */

import { setTimeout as delay } from 'node:timers/promises'
import type { GrokMainEvent, MuseMediaPartView, MuseToolCallView } from '@shared/ipc'
import type { GrokWatchTarget } from '../../adapters/grokbot/grokRequests'
import type { GrokConnectClient } from './connectClient'
import {
  asObj, str,
  type GrokPendingApprovalItem,
  type ParsedGrokTranscriptEntry
} from './grokTranscriptDecoder'
import {
  compareGrokEntries, GrokEntryRevisions, grokRows, grokSeq, grokSessionKey,
  hydrateGrokEntry, matchesGrokScope, readGrokTranscriptGap, transcriptEntries
} from './grokTranscriptWatch'

interface AgentCursorState {
  agentId: string
  generation: number
  afterUpdatedSeq: string
  sessionId: string
  seeded: boolean
  revisions: GrokEntryRevisions
  backfillMinSeq?: string
  lastBackfilled?: string
}

interface PresignedCacheEntry {
  url: string
  expiresAtMs: number
  contentType?: string
}

export interface GrokAccountWatchHandle {
  accountId: string
  stop: () => void
  rebindNetwork: () => void
  watchesSession: (agentId: string, sessionId: string) => boolean
  updateTargets: (
    agentIds: string[],
    conversationMap?: Record<string, string | string[]>,
    targets?: GrokWatchTarget[]
  ) => void
  listApprovals: (agentId?: string) => GrokPendingApprovalItem[]
  removeApproval: (idOrPrefix: string) => void
  resolveMediaUrls: (
    client: GrokConnectClient,
    agentId: string,
    sessionId: string,
    media: MuseMediaPartView[] | undefined,
    signal?: AbortSignal
  ) => Promise<MuseMediaPartView[] | undefined>
}

function maxSeqStr(a: string, b: string): string {
  return grokSeq(a) >= grokSeq(b) ? a : b
}

const ACTIVITY_LABELS: Record<string, { text: string; emoji: string }> = {
  '1': { text: '正在执行命令…', emoji: '⚡' },
  GROK_BOT_AGENT_ACTIVITY_CODE_RUNNING_COMMAND: { text: '正在执行命令…', emoji: '⚡' },
  '2': { text: '正在编辑文件…', emoji: '✏️' },
  GROK_BOT_AGENT_ACTIVITY_CODE_EDITING_FILE: { text: '正在编辑文件…', emoji: '✏️' },
  '3': { text: '正在读取文件…', emoji: '📄' },
  GROK_BOT_AGENT_ACTIVITY_CODE_READING_FILES: { text: '正在读取文件…', emoji: '📄' },
  '4': { text: '正在搜索工作区…', emoji: '🔍' },
  GROK_BOT_AGENT_ACTIVITY_CODE_SEARCHING: { text: '正在搜索工作区…', emoji: '🔍' },
  '5': { text: '正在操作云端电脑…', emoji: '🖥️' },
  GROK_BOT_AGENT_ACTIVITY_CODE_USING_COMPUTER: { text: '正在操作云端电脑…', emoji: '🖥️' },
  '6': { text: '正在浏览网页…', emoji: '🌐' },
  GROK_BOT_AGENT_ACTIVITY_CODE_BROWSING_WEB: { text: '正在浏览网页…', emoji: '🌐' },
  '7': { text: '正在委派子代理…', emoji: '🤖' },
  GROK_BOT_AGENT_ACTIVITY_CODE_DELEGATING_TO_AGENT: { text: '正在委派子代理…', emoji: '🤖' },
  '8': { text: '正在检索记忆与历史…', emoji: '🧠' },
  GROK_BOT_AGENT_ACTIVITY_CODE_RECALLING: { text: '正在检索记忆与历史…', emoji: '🧠' },
  '9': { text: '正在调用外部工具…', emoji: '🔌' },
  GROK_BOT_AGENT_ACTIVITY_CODE_CALLING_SERVICE: { text: '正在调用外部工具…', emoji: '🔌' },
  '10': { text: '正在准备交互卡片…', emoji: '🗂️' },
  GROK_BOT_AGENT_ACTIVITY_CODE_PREPARING_PROMPT: { text: '正在准备交互卡片…', emoji: '🗂️' },
  '11': { text: '正在思考…', emoji: '💭' },
  GROK_BOT_AGENT_ACTIVITY_CODE_WORKING: { text: '正在思考…', emoji: '💭' },
  '12': { text: '正在启动云端沙盒…', emoji: '🚀' },
  GROK_BOT_AGENT_ACTIVITY_CODE_STARTING_UP: { text: '正在启动云端沙盒…', emoji: '🚀' },
  '13': { text: '正在联网搜索…', emoji: '🔎' },
  GROK_BOT_AGENT_ACTIVITY_CODE_SEARCHING_WEB: { text: '正在联网搜索…', emoji: '🔎' }
}

const watches = new Map<string, AccountWatchController>()

class AccountWatchController implements GrokAccountWatchHandle {
  readonly accountId: string
  private readonly createClient: () => Promise<GrokConnectClient>
  private readonly emit: (event: GrokMainEvent) => void
  private readonly cursors = new Map<string, AgentCursorState>()
  private readonly conversations = new Map<string, { agentId: string; sessionId: string }>()
  private readonly conversationsByScope = new Map<string, Set<string>>()
  private readonly boundAgents = new Set<string>()
  private readonly approvals = new Map<string, GrokPendingApprovalItem>()
  private readonly presignedReads = new Map<string, PresignedCacheEntry>()
  private readonly recentTools = new Map<string, Map<string, MuseToolCallView>>()

  private stopped = false
  private currentAbort: AbortController | null = null
  private loopPromise: Promise<void> | null = null
  private restartRequested = false

  constructor(opts: {
    accountId: string
    createClient: () => Promise<GrokConnectClient>
    emit: (event: GrokMainEvent) => void
  }) {
    this.accountId = opts.accountId
    this.createClient = opts.createClient
    this.emit = opts.emit
  }

  private emitAssistantEntry(
    agentId: string,
    sessionId: string,
    parsed: ParsedGrokTranscriptEntry,
    resolvedMedia: MuseMediaPartView[] | undefined,
    toolsArr: MuseToolCallView[] | undefined
  ): void {
    const bound = this.conversationsByScope.get(grokSessionKey(agentId, sessionId))
    const targets = bound ?? (this.boundAgents.has(agentId) ? [] : [undefined])
    for (const conversationId of targets) {
      this.emit({
        type: 'stream',
        accountId: this.accountId,
        conversationId,
        agentId,
        sessionId: sessionId || undefined,
        messageId: `grok_${parsed.entryId}`,
        text: parsed.text,
        done: !parsed.isStreaming,
        ...(parsed.widgets?.length ? { widgets: parsed.widgets } : {}),
        ...(parsed.richWidgets?.length ? { richWidgets: parsed.richWidgets } : {}),
        ...(toolsArr ? { tools: toolsArr } : {}),
        ...(resolvedMedia?.length ? { media: resolvedMedia } : {})
      })
    }
  }

  rebindNetwork(): void {
    this.presignedReads.clear()
    if (!this.stopped) {
      this.triggerReconnect()
    }
  }

  watchesSession(agentId: string, sessionId: string): boolean {
    return this.cursors.has(grokSessionKey(agentId, sessionId))
  }

  updateTargets(
    agentIds: string[],
    conversationMap?: Record<string, string | string[]>,
    targets: GrokWatchTarget[] = []
  ): void {
    const size = this.cursors.size
    if (conversationMap) {
      const previous = new Map(this.conversations)
      this.conversations.clear()
      for (const [agentId, conv] of Object.entries(conversationMap)) {
        if (!agentId) continue
        for (const conversationId of Array.isArray(conv) ? conv : [conv]) {
          if (!conversationId) continue
          const old = previous.get(conversationId)
          const sessionId = old?.agentId === agentId ? old.sessionId : ''
          this.cursor(agentId, sessionId)
          this.conversations.set(conversationId, { agentId, sessionId })
        }
      }
    }
    for (const id of agentIds) if (id) this.cursor(id, '')
    for (const target of targets) {
      const { agentId, sessionId, conversationId } = target
      if (!agentId || typeof sessionId !== 'string') continue
      this.cursor(agentId, sessionId)
      if (conversationId) this.conversations.set(conversationId, target)
    }
    if (conversationMap || targets.some((target) => target.conversationId)) {
      this.conversationsByScope.clear()
      this.boundAgents.clear()
      for (const [conversationId, target] of this.conversations) {
        const key = grokSessionKey(target.agentId, target.sessionId)
        let ids = this.conversationsByScope.get(key)
        if (!ids) this.conversationsByScope.set(key, (ids = new Set()))
        ids.add(conversationId)
        this.boundAgents.add(target.agentId)
      }
    }
    if (!this.stopped && (!this.loopPromise || this.cursors.size !== size)) {
      this.triggerReconnect()
    }
  }

  private cursor(agentId: string, sessionId: string): AgentCursorState {
    const key = grokSessionKey(agentId, sessionId)
    let cursor = this.cursors.get(key)
    if (!cursor) {
      cursor = { agentId, sessionId, generation: 0, afterUpdatedSeq: '0', seeded: false, revisions: new GrokEntryRevisions() }
      this.cursors.set(key, cursor)
    }
    return cursor
  }

  restartIdentity(): AccountWatchController {
    this.stop()
    const next = new AccountWatchController({ accountId: this.accountId, createClient: this.createClient, emit: this.emit })
    next.broadcastApprovals()
    next.triggerReconnect()
    return next
  }

  listApprovals(agentId?: string): GrokPendingApprovalItem[] {
    const all = [...this.approvals.values()]
    return agentId ? all.filter((a) => a.agentId === agentId) : all
  }

  removeApproval(idOrPrefix: string): void {
    let changed = false
    for (const [k, v] of this.approvals.entries()) {
      if (
        k === idOrPrefix ||
        v.id === idOrPrefix ||
        v.requestId === idOrPrefix ||
        v.id.startsWith(`${idOrPrefix}:`)
      ) {
        this.approvals.delete(k)
        changed = true
      }
    }
    if (changed) {
      this.broadcastApprovals()
    }
  }

  private broadcastApprovals(agentId?: string): void {
    this.emit({
      type: 'approvals',
      accountId: this.accountId,
      agentId,
      pending: this.listApprovals()
    })
  }

  async resolveMediaUrls(
    client: GrokConnectClient,
    agentId: string,
    sessionId: string,
    media: MuseMediaPartView[] | undefined,
    signal?: AbortSignal
  ): Promise<MuseMediaPartView[] | undefined> {
    if (this.stopped || !media?.length) return media
    signal?.throwIfAborted()
    const now = Date.now()
    const keyFor = (path: string) => JSON.stringify([agentId, sessionId, path])
    const toResolve: string[] = []
    for (const part of media) {
      if (!part.path || /^https?:\/\/|^data:/i.test(part.path)) continue
      const cached = this.presignedReads.get(keyFor(part.path))
      if (!cached || cached.expiresAtMs - now < 30_000) {
        toResolve.push(part.path)
      }
    }

    if (toResolve.length > 0) {
      try {
        const res = await client.resolveAttachmentReads({
          agentId,
          sessionId: sessionId || undefined,
          paths: [...new Set(toResolve)]
        }, signal)
        if (this.stopped) return media
        signal?.throwIfAborted()
        const reads = Array.isArray(res['reads']) ? (res['reads'] as unknown[]) : []
        for (const r of reads) {
          const ro = asObj(r)
          if (!ro) continue
          const p = str(ro['path'])
          const url = str(ro['url'])
          const exp = Number(ro['expiresAtMs'] ?? ro['expires_at_ms'] ?? now + 15 * 60_000)
          const ct = str(ro['contentType'] ?? ro['content_type']) || undefined
          if (p && url) {
            this.presignedReads.set(keyFor(p), {
              url,
              expiresAtMs: exp > 0 ? exp : now + 15 * 60_000,
              contentType: ct
            })
          }
        }
      } catch {
        signal?.throwIfAborted()
      }
    }

    return media.map((part) => {
      if (!part.path || /^https?:\/\/|^data:/i.test(part.path)) return part
      const cached = this.presignedReads.get(keyFor(part.path))
      if (!cached || cached.expiresAtMs <= now) return part
      const mime = part.mimeType || cached.contentType
      return {
        ...part,
        path: cached.url,
        mimeType: mime,
        kind: mime?.startsWith('image/') ? 'image' : part.kind
      }
    })
  }

  private triggerReconnect(): void {
    this.restartRequested = true
    if (this.currentAbort) {
      this.currentAbort.abort()
    }
    if (!this.loopPromise && !this.stopped) {
      this.loopPromise = this.runLoop().finally(() => {
        this.loopPromise = null
      })
    }
  }

  stop(): void {
    this.stopped = true
    if (this.currentAbort) {
      this.currentAbort.abort()
      this.currentAbort = null
    }
  }

  private async seedWatermarks(client: GrokConnectClient, signal: AbortSignal): Promise<void> {
    const unseeded = [...this.cursors.values()].filter((cursor) => !cursor.seeded || cursor.backfillMinSeq !== undefined)
    for (let offset = 0; offset < unseeded.length; offset += 8) {
      const results = await Promise.allSettled(unseeded.slice(offset, offset + 8).map(async (cursor) => {
        try {
          const backfilling = cursor.backfillMinSeq !== undefined
          const floor = grokSeq(cursor.backfillMinSeq)
          const data = backfilling
            ? await readGrokTranscriptGap(client, cursor, { floor, signal })
            : await this.readInitialPage(client, cursor, signal)
          const generation = data.generation ?? cursor.generation
          const generationChanged = generation !== cursor.generation
          if (generationChanged) {
            this.resetCursor(cursor, generation)
            if (backfilling) cursor.backfillMinSeq = '0'
          }
          for (const entry of data.entries) {
            const publish = backfilling && (generationChanged || grokSeq(entry.updatedSeq) > floor)
            await this.applyEntry(client, cursor, entry, signal, publish)
          }
          cursor.afterUpdatedSeq = maxSeqStr(cursor.afterUpdatedSeq, data.watermark)
          cursor.backfillMinSeq = undefined
          cursor.seeded = true
        } catch (error) {
          signal.throwIfAborted()
          if (cursor.backfillMinSeq !== undefined) throw error
          // If initial seeding fails, a subscription from zero still receives replay.
        }
      }))
      signal.throwIfAborted()
      const failure = results.find((result) => result.status === 'rejected')
      if (failure) throw failure.reason
    }
  }

  private async readInitialPage(client: GrokConnectClient, cursor: AgentCursorState, signal: AbortSignal) {
    const { agentId, sessionId } = cursor
    const page = asObj(await client.listTranscriptEntries({ agentId, sessionId, limit: 20 }, signal)) ?? {}
    signal.throwIfAborted()
    const generation = Number(page['generation'])
    return {
      entries: transcriptEntries(page, agentId, sessionId).sort(compareGrokEntries),
      generation: Number.isSafeInteger(generation) && generation >= 0 ? generation : undefined,
      watermark: str(page['currentUpdatedSeq'] ?? page['current_updated_seq'] ?? page['updatedSeq'] ?? page['updated_seq'])
    }
  }

  private async runLoop(): Promise<void> {
    let consecutiveFailures = 0
    while (!this.stopped) {
      this.restartRequested = false
      const ac = new AbortController()
      this.currentAbort = ac
      let lifetimeTimer: ReturnType<typeof setTimeout> | undefined
      const started = Date.now()
      try {
        const client = await this.createClient()
        ac.signal.throwIfAborted()
        await this.seedWatermarks(client, ac.signal)
        ac.signal.throwIfAborted()
        const cursors = [...this.cursors.values()].map((c) => ({
          agent_id: c.agentId, generation: c.generation, after_updated_seq: c.afterUpdatedSeq, session_id: c.sessionId
        }))
        for await (const frame of client.watchTranscripts({ cursors }, ac.signal)) {
          if (ac.signal.aborted) break
          const lifetimeMs = Number(frame['absolute_lifetime_ms'] ?? frame['absoluteLifetimeMs'] ?? 0)
          if (lifetimeMs > 5_000 && !lifetimeTimer) {
            lifetimeTimer = setTimeout(() => this.triggerReconnect(), Math.max(5_000, lifetimeMs - 3_000))
          }
          await this.handleFrame(client, frame, ac.signal)
        }
      } catch {
        // Failed and unexpectedly closed streams use the same backoff.
      } finally {
        clearTimeout(lifetimeTimer)
      }
      if (!this.stopped && !this.restartRequested) {
        if (Date.now() - started > 30_000) consecutiveFailures = 0
        const backoffMs = Math.min(20_000, Math.round(1_200 * Math.pow(1.7, consecutiveFailures++)))
        await delay(backoffMs, undefined, { signal: ac.signal }).catch(() => undefined)
      } else {
        consecutiveFailures = 0
      }
      if (this.currentAbort === ac) this.currentAbort = null
    }
  }

  private resetCursor(cursor: AgentCursorState, generation: number): void {
    cursor.generation = generation
    cursor.afterUpdatedSeq = '0'
    cursor.backfillMinSeq = undefined
    cursor.lastBackfilled = undefined
    cursor.revisions = new GrokEntryRevisions()
    this.recentTools.delete(grokSessionKey(cursor.agentId, cursor.sessionId))
    for (const [id, approval] of this.approvals) {
      if (approval.agentId === cursor.agentId && (approval.sessionId ?? '') === cursor.sessionId) this.approvals.delete(id)
    }
  }

  private async applyEntry(
    client: GrokConnectClient, cursor: AgentCursorState, raw: ParsedGrokTranscriptEntry,
    signal: AbortSignal, publish: boolean
  ): Promise<void> {
    const { agentId, sessionId } = cursor
    const parsed = await hydrateGrokEntry(client, agentId, sessionId, raw, signal)
    signal.throwIfAborted()
    const revision = cursor.revisions.check(parsed)
    if (!revision) return
    // Do not claim the revision or advance the cursor until media resolution is complete.
    const resolvedMedia = publish && parsed.role === 'assistant'
      ? await this.resolveMediaUrls(client, agentId, sessionId, parsed.media, signal)
      : undefined
    signal.throwIfAborted()
    cursor.revisions.remember(parsed.entryId, revision)
    cursor.afterUpdatedSeq = maxSeqStr(cursor.afterUpdatedSeq, parsed.updatedSeq)
    if (parsed.settledApprovalKey) this.removeApproval(parsed.settledApprovalKey)
    if (parsed.approval) {
      this.approvals.set(parsed.approval.id, parsed.approval)
      this.broadcastApprovals(agentId)
    }
    if (!publish) return
    const key = grokSessionKey(agentId, sessionId)
    if (parsed.role === 'user') {
      this.recentTools.delete(key)
      return
    }
    let tools = this.recentTools.get(key)
    if (parsed.role === 'tool' && parsed.toolCall) {
      if (!tools) this.recentTools.set(key, (tools = new Map()))
      tools.set(parsed.toolCall.id, parsed.toolCall)
      if (tools.size > 12) tools.delete(tools.keys().next().value!)
    }
    if (parsed.role !== 'assistant') return
    if (parsed.text || parsed.widgets?.length || parsed.richWidgets?.length || resolvedMedia?.length) {
      this.emitAssistantEntry(agentId, sessionId, parsed, resolvedMedia, tools?.size ? [...tools.values()] : undefined)
    }
    if (!parsed.isStreaming) this.recentTools.delete(key)
  }

  private async handleFrame(client: GrokConnectClient, frame: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const rows = grokRows(frame)
    if (rows) {
      const agentId = str(rows['agentId'] ?? rows['agent_id'])
      const sessionId = str(rows['sessionId'] ?? rows['session_id'])
      if (!agentId) return
      const cursor = this.cursor(agentId, sessionId)
      const generation = Number(rows['generation'] ?? cursor.generation)
      if (Number.isSafeInteger(generation) && generation >= 0) {
        if (generation < cursor.generation) return
        if (generation > cursor.generation) this.resetCursor(cursor, generation)
      }
      cursor.seeded = true
      const entries = transcriptEntries(rows, agentId, sessionId)
      for (const entry of entries.sort(compareGrokEntries)) {
        await this.applyEntry(client, cursor, entry, signal, true)
      }
      const deletes = Array.isArray(rows['deletes']) ? rows['deletes'] : []
      const deletedMessageIds: string[] = []
      for (const value of deletes) {
        const row = asObj(value)
        if (!row || !matchesGrokScope(row, agentId, sessionId, true)) continue
        const updatedSeq = str(row['updatedSeq'] ?? row['updated_seq'] ?? row['seq'])
        const id = str(row['entryId'] ?? row['entry_id'] ?? row['seq'])
        cursor.afterUpdatedSeq = maxSeqStr(cursor.afterUpdatedSeq, updatedSeq)
        if (!id || !cursor.revisions.remove(id, updatedSeq)) continue
        deletedMessageIds.push(`grok_${id}`)
        this.removeApproval(id)
      }
      if (deletedMessageIds.length && this.isRouted(agentId, sessionId)) this.emit({
        type: 'message_deleted', accountId: this.accountId, agentId, sessionId: sessionId || undefined, messageIds: deletedMessageIds
      })
      return
    }

    // 3. `agent_state` (`GrokBotAgentLiveState`)
    const agentState = asObj(frame['agent_state'] ?? frame['agentState'])
    if (agentState) {
      const agentId = str(agentState['agentId'] ?? agentState['agent_id'])
      if (!agentId) return
      const sessionId = str(agentState['sessionId'] ?? agentState['session_id']) || undefined
      if (sessionId !== undefined && !this.isRouted(agentId, sessionId)) return
      const isRunning = Boolean(agentState['isRunning'] ?? agentState['is_running'])
      const isComposing = Boolean(
        agentState['isComposingMessage'] ?? agentState['is_composing_message']
      )
      const hasSubagents = Boolean(
        agentState['hasRunningSubagents'] ?? agentState['has_running_subagents']
      )
      const actObj = asObj(agentState['activity'])
      const code = str(actObj?.['code'] ?? (isRunning ? '11' : '0'))
      const mapped = ACTIVITY_LABELS[code]
      this.emit({
        type: 'activity',
        accountId: this.accountId,
        agentId,
        sessionId,
        busy: isRunning || isComposing,
        isComposing,
        hasRunningSubagents: hasSubagents,
        activityCode: code,
        activityText: mapped?.text ?? (isComposing ? '正在输入回复…' : isRunning ? '正在运行…' : undefined),
        activityEmoji: mapped?.emoji
      })
      return
    }

    // 4. `turn_failed` (`GrokBotTurnFailed`)
    const turnFailed = asObj(frame['turn_failed'] ?? frame['turnFailed'])
    if (turnFailed) {
      const agentId = str(turnFailed['agentId'] ?? turnFailed['agent_id'])
      if (!agentId) return
      const sessionId = str(turnFailed['sessionId'] ?? turnFailed['session_id']) || undefined
      if (!this.isRouted(agentId, sessionId ?? '')) return
      const turnId = str(turnFailed['turnId'] ?? turnFailed['turn_id']) || undefined
      const code = str(turnFailed['code'] ?? 'FAILED')
      const summary = str(turnFailed['summary'] ?? 'Grok Bot 执行该轮对话失败')
      this.emit({
        type: 'turn_failed',
        accountId: this.accountId,
        agentId,
        sessionId,
        turnId,
        code,
        summary
      })
      return
    }

    // 5. `roster_changed` (`GrokBotRosterChanged`)
    const rosterChanged = asObj(frame['roster_changed'] ?? frame['rosterChanged'])
    if (rosterChanged) {
      const kind = str(rosterChanged['kind'] ?? 'UPDATED')
      const agentId = str(rosterChanged['agentId'] ?? rosterChanged['agent_id'])
      const agent = asObj(rosterChanged['agent']) ?? undefined
      if (agentId && !kind.includes('DELETED')) this.cursor(agentId, '')
      this.emit({
        type: 'roster_changed',
        accountId: this.accountId,
        kind,
        agentId,
        agent
      })
      return
    }

    // 6. `box_state` (`SandBoxStateChanged`)
    const boxState = asObj(frame['box_state'] ?? frame['boxState'])
    if (boxState) {
      this.emit({
        type: 'box_state',
        accountId: this.accountId,
        state: boxState
      })
      return
    }

    // 7. `page_title_changed` (`GrokBotPageTitleChanged`)
    const pageChanged = asObj(frame['page_title_changed'] ?? frame['pageTitleChanged'])
    if (pageChanged) {
      this.emit({
        type: 'page_changed',
        accountId: this.accountId,
        storeId: str(pageChanged['storeId'] ?? pageChanged['store_id']),
        canvasId: str(pageChanged['canvasId'] ?? pageChanged['canvas_id']) || undefined,
        documentId: str(pageChanged['documentId'] ?? pageChanged['document_id']),
        title: str(pageChanged['title']),
        contentChanged: Boolean(pageChanged['contentChanged'] ?? pageChanged['content_changed'])
      })
      return
    }

    // 8. `cleared` (`GrokBotTranscriptCleared`) -> bump generation and reset seq
    const cleared = asObj(frame['cleared'])
    if (cleared) {
      const agentId = str(cleared['agentId'] ?? cleared['agent_id'])
      const sessionId = str(cleared['sessionId'] ?? cleared['session_id'])
      const newGen = Number(cleared['newGeneration'] ?? cleared['new_generation'] ?? 0)
      const cur = this.cursors.get(grokSessionKey(agentId, sessionId))
      if (cur && newGen > cur.generation && Number.isSafeInteger(newGen)) this.resetCursor(cur, newGen)
      return
    }

    // 9. `cursor_too_old` (`GrokBotTranscriptCursorTooOld`) -> backfill missed gap and reconnect
    const tooOld = asObj(frame['cursor_too_old'] ?? frame['cursorTooOld'])
    if (tooOld) {
      const agentId = str(tooOld['agentId'] ?? tooOld['agent_id'])
      const sessionId = str(tooOld['sessionId'] ?? tooOld['session_id'])
      const cur = this.cursors.get(grokSessionKey(agentId, sessionId))
      if (cur) {
        const floor = cur.afterUpdatedSeq
        if (cur.lastBackfilled === floor) {
          cur.backfillMinSeq = floor
          throw new Error('Grok transcript cursor is still expired after backfill')
        }
        cur.lastBackfilled = floor
        cur.backfillMinSeq = floor
        cur.afterUpdatedSeq = '0'
        this.triggerReconnect()
      }
    }
  }

  private isRouted(agentId: string, sessionId: string): boolean {
    return !this.boundAgents.has(agentId) || this.conversationsByScope.has(grokSessionKey(agentId, sessionId))
  }
}

export function ensureGrokAccountWatch(opts: {
  accountId: string
  agentIds?: string[]
  conversationMap?: Record<string, string | string[]>
  targets?: GrokWatchTarget[]
  createClient: () => Promise<GrokConnectClient>
  emit: (event: GrokMainEvent) => void
}): GrokAccountWatchHandle {
  let ctrl = watches.get(opts.accountId)
  if (!ctrl) {
    ctrl = new AccountWatchController({
      accountId: opts.accountId,
      createClient: opts.createClient,
      emit: opts.emit
    })
    watches.set(opts.accountId, ctrl)
  }
  ctrl.updateTargets(opts.agentIds ?? [], opts.conversationMap, opts.targets)
  return ctrl
}

export function getGrokAccountWatch(accountId: string): GrokAccountWatchHandle | undefined {
  return watches.get(accountId)
}

export function restartGrokAccountWatch(accountId: string): void {
  const watch = watches.get(accountId)
  if (watch) watches.set(accountId, watch.restartIdentity())
}

export function rebindGrokAccountWatch(accountId: string): void {
  if (accountId === '*') {
    for (const ctrl of watches.values()) ctrl.rebindNetwork()
    return
  }
  watches.get(accountId)?.rebindNetwork()
}

export function stopGrokAccountWatch(accountId: string): void {
  if (accountId === '*') {
    for (const ctrl of watches.values()) ctrl.stop()
    watches.clear()
    return
  }
  const ctrl = watches.get(accountId)
  if (ctrl) {
    ctrl.stop()
    watches.delete(accountId)
  }
}
