import { currentHarkBrowser } from '@shared/harkBrowserPreview'
import { pendingHarkAsks } from '@shared/harkAsks'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { HarkRequest } from '../../adapters/hark/harkRequests'
import {
  HARK_CHANNELS,
  type HarkAuthStatus,
  type HarkImportCredentialsRequest,
  type HarkOpenLoginRequest,
  type HarkRpcResponse,
  type MuseMediaPartView,
  type MuseRichWidgetView,
  type MuseToolCallView
} from '@shared/ipc'
import {
  callHarkApi,
  cancelHarkWatch,
  clearHarkAccount,
  conversationIdFromPayload,
  downloadHarkArtifact,
  extractMessages,
  fetchConversationSnapshotSummary,
  fetchHarkHistoryPage,
  getAuthSession,
  getConversationStatuses,
  getMainConversation,
  getProfile,
  harkReplySnippet,
  importHarkCredentials,
  listConversations,
  pollHarkConversation,
  sendMessage,
  timezoneName,
  uploadHarkAttachment,
  watchHarkConversationSync,
  extractHandle,
  HarkApiError,
  HarkRequestTimeout,
  HarkConversationSyncState,
  preparedSessionForAccount,
  readHarkStream,
  registerHarkViewStop,
  withHarkCredentials,
  type HarkChatMessage,
  type HarkUploadedAttachment,
  harkRunningToolLine
} from './harkClient'
import { harkTurnBusy } from './harkBusy'
import { logHarkCall, logHarkFrame } from './harkFrameLog'
import { cancelHarkLogin, completeHarkCredentialImport, onHarkLoginEvent, openHarkLoginWindow } from './harkLogin'
import { loadAccountProxyUrl } from '../muse/accountProxy'
import { guessMediaMimeFromName } from '../mediaMime'
import { harkSessionExpiresAt, logHarkSessionDebug, probeHarkSession } from './harkSession'
import { harkWebViewUrlAfterSignIn } from './harkWebView'
import { reloadAccountWebViews } from '../webViewIpc'
import { harkCreateProjectBody, harkProjectId } from '@shared/harkProjects'

function mapHarkTools(msg: HarkChatMessage): MuseToolCallView[] | undefined {
  if (!msg.toolCalls || msg.toolCalls.length === 0) return undefined
  return msg.toolCalls.map((tc) => ({
    id: tc.dispatchId,
    name: tc.name,
    status:
      /^(running|pending|active|started|waiting_for_input|awaiting_input)$/i.test(tc.status)
        ? 'running'
        : /^(failed|errored|error)$/i.test(tc.status)
          ? 'errored'
          : 'completed',
    summary: tc.detail || tc.url || tc.command || tc.result
  }))
}

function mapHarkMedia(msg: HarkChatMessage): MuseMediaPartView[] | undefined {
  if (!msg.artifacts || msg.artifacts.length === 0) return undefined
  const out: MuseMediaPartView[] = []
  const seen = new Set<string>()
  for (const a of msg.artifacts) {
    const path = a.downloadUrl || (a.s3Key ? `harkatt://${a.s3Key}` : a.path)
    if (!path || seen.has(path)) continue
    seen.add(path)
    const name = a.name || a.path.split(/[?#]/, 1)[0]?.split('/').pop() || 'artifact'
    const mimeType = a.mimeType || guessMediaMimeFromName(name || a.path)
    const isImg =
      Boolean(mimeType && mimeType.toLowerCase().startsWith('image/')) ||
      /\.(png|jpe?g|gif|webp|svg|avif|bmp)(?:[?#].*)?$/i.test(name || a.path || '')
    out.push({
      kind: isImg ? 'image' : 'file',
      path,
      name,
      mimeType
    })
  }
  return out.length > 0 ? out : undefined
}

function mapHarkRichWidgets(msg: HarkChatMessage): MuseRichWidgetView[] | undefined {
  const out: MuseRichWidgetView[] = []
  if (msg.links?.length) out.push({ kind: 'link_cards', widgetId: `hark_links_${msg.id}`, links: msg.links })
  if (!msg.actions || msg.actions.length === 0) return out.length ? out : undefined
  return [
    ...out,
    {
      kind: 'text_with_button',
      widgetId: `hark_act_${msg.id}`,
      text: '',
      buttons: msg.actions.map((a) => ({
        label: a.label || `Connect ${a.connector ?? ''}`,
        actionText: a.connector ? `Connect ${a.connector}` : a.label,
        // GOXF 2026-11-26: without this the renderer never asked Hark for the auth link and
        // just posted "Connect github" into the chat.
        ...(a.connector ? { command: `hark:connect:${a.connector}` } : {})
      }))
    }
  ]
}

// The message a reply answers, resolved within this conversation: quote, its id, and a picture when it has a web URL.
function replyView(m: HarkChatMessage, byId: Map<string, HarkChatMessage>) {
  const target = m.replyTo?.id ? byId.get(m.replyTo.id) : undefined
  const media = target && mapHarkMedia(target)
  const replyQuote = harkReplySnippet(target?.content ?? m.replyTo?.text ?? '', media)
  if (!replyQuote) return {}
  const replyThumb = media?.find((p) => p.kind === 'image' && /^(https?:|data:image\/)/i.test(p.path))?.path
  return { replyQuote, ...(target ? { replyToId: target.id } : {}), ...(replyThumb ? { replyThumb } : {}) }
}

function historyView(messages: HarkChatMessage[]) {
  const byId = new Map(messages.map((m) => [m.id, m]))
  return messages.map((m) => ({
    // User messages keep their pictures too: Hark's history carries what the user attached.
    ...m, media: mapHarkMedia(m), ...replyView(m, byId),
    richWidgets: !/^user$/i.test(m.role) ? mapHarkRichWidgets(m) : undefined
  }))
}

// GOXF Issue #7: keyed per subscription, so split panes can watch several projects at once.
const visibleProjects = new Map<string, { subscription: string; accountId: string; stop: () => void }>()
const activeRequests = new Map<string, { accountId: string; controller: AbortController }>()

function observeProject(event: IpcMainInvokeEvent, req: Extract<HarkRequest, { op: 'observeProject' }>) {
  const sender = event.sender
  const key = `${sender.id}:${req.subscription}`
  visibleProjects.get(key)?.stop()
  const controller = new AbortController()
  const signal = controller.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    controller.abort()
    unregister()
    clearTimeout(timer)
    sender.off('destroyed', stop)
    sender.off('did-navigate', stop)
    if (visibleProjects.get(key)?.stop === stop) visibleProjects.delete(key)
  }
  const unregister = registerHarkViewStop(req.accountId, stop)
  visibleProjects.set(key, { accountId: req.accountId, subscription: req.subscription, stop })
  sender.once('destroyed', stop)
  sender.once('did-navigate', stop)
  void (async () => {
    const session = await preparedSessionForAccount(req.accountId)
    const state = new HarkConversationSyncState()
    const onFrame = (frame: string) => {
      if (signal.aborted) return
      logHarkFrame(req.conversationId, frame)
      // GOXF: live-status-only frames still go out, so the status line stays current.
      if (!state.applyFrame(frame) || timer) return
      timer = setTimeout(() => {
        timer = undefined
        if (signal.aborted || sender.isDestroyed()) return
        sender.send(HARK_CHANNELS.event, {
          type: 'projectHistory', accountId: req.accountId, conversationId: req.conversationId,
          subscription: req.subscription, messages: historyView(state.orderedMessages()),
          browserPreview: currentHarkBrowser(state.extractPanels()),
          live: state.liveStatus(), asks: pendingHarkAsks(state.extractAsks())
        })
      }, 150)
    }
    const sseManager = randomUUID()
    let dial = 'initial'
    while (!signal.aborted) {
      await readHarkStream(session, req.conversationId, sseManager, dial, signal, onFrame, undefined, true).catch(() => undefined)
      dial = 'reconnect'
      const pollManager = randomUUID()
      let first = true
      let cursor: string | undefined
      let floor: string | undefined
      for (let attempt = 0; attempt < 5 && !signal.aborted; attempt++) {
        const page = await pollHarkConversation(session, req.conversationId, pollManager, { first, cursor, floor, signal })
          .catch(() => null)
        if (page && Array.isArray(page.frames)) {
          first = false
          cursor = page.cursor ?? cursor
          floor = page.floor ?? floor
          for (const frame of page.frames) onFrame(frame)
        }
        await delay(3000, undefined, { signal })
      }
    }
  })().catch(() => { if (!signal.aborted) stop() })
}

function ownerWindow(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined
}

function broadcast(payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(HARK_CHANNELS.event, payload)
  }
}

// Every Hark account seen since startup with its last known sign-in state (undefined: never verified).
// The startup probe (GET get-session) is itself the first renewal; the timer keeps renewing like an
// open Hark tab, retries accounts that failed at startup and pushes any change to the UI.
const knownAccounts = new Map<string, boolean | undefined>()
const RENEW_EVERY_MS = 20 * 60_000
setInterval(() => {
  for (const id of knownAccounts.keys()) void recheck(id)
}, RENEW_EVERY_MS).unref()

async function recheck(accountId: string): Promise<void> {
  const before = knownAccounts.get(accountId)
  let st: HarkAuthStatus
  try {
    st = await statusFor(accountId)
  } catch (error) {
    broadcast({ type: 'sessionCheck', accountId, result: 'failed', at: Date.now(),
      message: error instanceof Error ? error.message : String(error) })
    return
  }
  broadcast(st.signedIn
    ? { type: 'sessionCheck', accountId, result: 'ok', at: Date.now(), expiresAt: st.expiresAt }
    : { type: 'sessionCheck', accountId, result: 'expired', at: Date.now() })
  if (st.signedIn === before) return
  broadcast(st.signedIn
    ? { type: 'login', accountId, signedIn: true as const, handle: st.handle, displayName: st.displayName }
    : { type: 'login', accountId, signedIn: false as const })
}

async function statusFor(accountId: string): Promise<HarkAuthStatus> {
  if (!knownAccounts.has(accountId)) {
    knownAccounts.set(accountId, undefined)
    if (process.env['BOTHUB_HARK_DEBUG'] === '1') void logHarkSessionDebug(accountId).catch(() => undefined)
  }
  const hasProxy = Boolean(await loadAccountProxyUrl(accountId).catch(() => true))
  return withHarkCredentials(accountId, async () => {
    const wasSignedIn = knownAccounts.get(accountId)
    const probe = await probeHarkSession(accountId, { reportConnectionErrors: true })
    knownAccounts.set(accountId, !('signedIn' in probe))
    if ('signedIn' in probe) return { accountId, signedIn: false, hasProxy }
    // Signed in from inside the embedded page: move it off the login page.
    if (wasSignedIn === false) reloadAccountWebViews(accountId, harkWebViewUrlAfterSignIn)
    const expiresAt = await harkSessionExpiresAt(accountId, probe.session)
    return { accountId, signedIn: true, handle: probe.handle, displayName: probe.displayName, hasProxy, expiresAt }
  })
}

async function runHarkRpc(req: HarkRequest, signal?: AbortSignal): Promise<HarkRpcResponse> {
  try {
    switch (req.op) {
      case 'authStatus':
        return { ok: true, data: await statusFor(req.accountId) }
      case 'getSession': {
        const session = await withHarkCredentials(req.accountId, () => getAuthSession(req.accountId))
        const { handle, displayName } = extractHandle(session)
        // Never return raw session tokens to renderer.
        return {
          ok: true,
          data: {
            accountId: req.accountId,
            signedIn: Boolean(session && (session.user || session.session)),
            handle,
            displayName,
            userId: session?.user?.id
          }
        }
      }
      case 'profile':
        return { ok: true, data: await getProfile(req.accountId) }
      case 'listConversations':
        return { ok: true, data: await listConversations(req.accountId) }
      case 'createConversation': {
        const result = await callHarkApi(req.accountId, {
          path: '/conversations',
          method: 'POST',
          body: harkCreateProjectBody(req.title, req.timezone ?? timezoneName())
        })
        const conversationId = conversationIdFromPayload(result, false)
        if (!conversationId) throw new Error('Hark returned no project ID')
        return { ok: true, data: { conversationId } }
      }
      case 'browserPreview': {
        const conversationId = req.conversationId ?? conversationIdFromPayload(await getMainConversation(req.accountId, undefined, signal))
        if (!conversationId) return { ok: true, data: null }
        const snapshot = await fetchConversationSnapshotSummary(req.accountId, conversationId, signal)
        return { ok: true, data: currentHarkBrowser(snapshot.panels) }
      }
      case 'conversationSnapshot':
      case 'mainConversation': {
        if (req.op === 'conversationSnapshot' && !harkProjectId(req.conversationId)) {
          return { ok: false, status: 400, message: 'conversationId required' }
        }
        const data = req.op === 'mainConversation'
          ? await getMainConversation(req.accountId, req.timezone ?? timezoneName(), signal) : null
        const convId = req.op === 'conversationSnapshot' ? req.conversationId : conversationIdFromPayload(data)
        const snap = convId ? await fetchConversationSnapshotSummary(req.accountId, convId, signal) : null
        const rawMessages = snap && snap.messages.length > 0 ? snap.messages : extractMessages(data)
        const messages = historyView(rawMessages)
        return {
          ok: true,
          data: {
            raw: data,
            conversationId: convId,
            messages,
            panels: snap?.panels ?? [],
            asks: snap?.asks ?? [],
            artifacts: snap?.artifacts ?? [],
            activeActivity: snap?.activeActivity ?? null,
            narration: snap?.narration ?? null,
            requests: snap?.requests ?? {},
            activeWork: snap?.activeWork ?? []
          }
        }
      }
      case 'olderHistory': {
        if (!harkProjectId(req.conversationId)) return { ok: false, status: 400, message: 'conversationId required' }
        const page = await fetchHarkHistoryPage(req.accountId, req.conversationId, { id: req.beforeId, createdAt: req.beforeCreatedAt }, signal)
        // The page shape is undocumented: keep a sample in hark-frames.log for the next fix.
        try {
          logHarkCall('/messages/history', { before: req.beforeId, beforeCreatedAt: req.beforeCreatedAt }, page.raw)
        } catch {
          /* logging only */
        }
        return { ok: true, data: { conversationId: req.conversationId, messages: historyView(page.messages), hasMore: page.hasMore } }
      }
      case 'conversationStatus':
        return { ok: true, data: await getConversationStatuses(req.accountId) }
      case 'sendMessage': {
        if (!harkProjectId(req.conversationId)) {
          return { ok: false, status: 400, message: 'conversationId required' }
        }
        const hasAttachments = Array.isArray(req.attachments) && req.attachments.length > 0
        if ((typeof req.text !== 'string' || !req.text.trim()) && !hasAttachments) {
          return { ok: false, status: 400, message: 'text or attachments required' }
        }
        let uploaded: HarkUploadedAttachment[] | undefined
        if (hasAttachments && req.attachments) {
          uploaded = []
          for (const a of req.attachments) {
            if (!a.dataBase64) continue
            uploaded.push(await uploadHarkAttachment(req.accountId, req.conversationId, a))
          }
        }
        const sent = await sendMessage(
          req.accountId,
          req.conversationId,
          (req.text ?? '').trim(),
          req.timezone ?? timezoneName(),
          uploaded
        )
        return {
          ok: true,
          data: {
            result: sent.result,
            idempotencyKey: sent.idempotencyKey,
            responseMessageId: sent.responseMessageId,
            conversationId: req.conversationId
          }
        }
      }
      case 'pollReply': {
        if (!harkProjectId(req.conversationId)) {
          return { ok: false, status: 400, message: 'conversationId required' }
        }
        const afterIds = new Set(Array.isArray(req.afterMessageIds) ? req.afterMessageIds : [])
        const streamOf = (msg: HarkChatMessage, done: boolean) => {
          const tools = mapHarkTools(msg)
          const media = mapHarkMedia(msg)
          const richWidgets = mapHarkRichWidgets(msg)
          broadcast({
            type: 'stream',
            accountId: req.accountId,
            sessionId: req.conversationId,
            conversationId: req.botId,
            messageId: `hark_${msg.id}`,
            text: msg.content.trim(),
            done,
            ...(tools ? { tools } : {}),
            ...(media ? { media } : {}),
            ...(richWidgets ? { richWidgets } : {})
          })
          return { tools, media, richWidgets }
        }
        const activity = (text: string) =>
          broadcast({
            type: 'activity',
            accountId: req.accountId,
            sessionId: req.conversationId,
            activityCode: text ? 'thinking' : 'idle',
            ...(text ? { activityText: text.slice(0, 120) } : {}),
            busy: Boolean(text)
          })
        // GOXF: the conversation-level line is the live one; a message's own narration goes stale.
        const livePhrase = (syncState: HarkConversationSyncState, msg?: HarkChatMessage) =>
          syncState.narration?.trim() ||
          syncState.activeActivity?.trim() ||
          msg?.narration?.trim() ||
          harkRunningToolLine(msg) ||
          syncState.liveStatus().text ||
          ''
        const hasPayload = (m: HarkChatMessage) =>
          Boolean(m.content.trim() || m.toolCalls?.length || m.artifacts?.length || m.actions?.length || m.links?.length)
        // Turn messages as last shown (by object: sync state replaces a message on change).
        const shown = new Map<string, HarkChatMessage>()
        // The tail showed Hark as busy, so it must close the turn (done + idle) when it ends.
        let tailOpen = false
        const watched = await watchHarkConversationSync(req.accountId, req.conversationId, {
          responseMessageId: req.responseMessageId === undefined ? undefined : String(req.responseMessageId),
          afterMessageIds: afterIds,
          timeoutMs: req.timeoutMs ?? 90_000,
          signal,
          onUpdate: (msg, syncState, replyDone) => {
            const busy = harkTurnBusy(syncState, afterIds)
            // A finished reply is only "done" once Hark's turn is idle too.
            const done = replyDone && !busy
            const activePhrase = livePhrase(syncState, msg) || (replyDone && busy ? '等待任务完成…' : '')
            if (!done && activePhrase) activity(activePhrase)
            if (!hasPayload(msg) && !done) return
            shown.set(msg.id, msg)
            streamOf(msg, done)
          },
          onTail: (syncState, ended) => {
            const busy = !ended && harkTurnBusy(syncState, afterIds)
            if (busy) {
              tailOpen = true
              activity(livePhrase(syncState) || '等待任务完成…')
            } else if (!ended) return
            for (const m of syncState.orderedMessages()) {
              if (/^user$/i.test(m.role) || afterIds.has(m.id)) continue
              if (shown.get(m.id) === m && !(ended && tailOpen)) continue
              shown.set(m.id, m)
              if (hasPayload(m)) streamOf(m, ended)
            }
            if (ended && tailOpen) activity('')
          }
        })
        // Hark still works on this turn: the tail keeps the status line and clears it at the end.
        const tailing = watched.tailing
        if (tailing) tailOpen = true

        const finalReply = watched.reply
        return {
          ok: true,
          data: {
            conversationId: req.conversationId,
            outcome: watched.outcome,
            error: watched.error,
            tailing,
            reply: finalReply && {
              ...finalReply,
              id: `hark_${finalReply.id}`,
              tools: mapHarkTools(finalReply),
              media: mapHarkMedia(finalReply),
              richWidgets: mapHarkRichWidgets(finalReply)
            }
          }
        }
      }
      case 'downloadArtifact': {
        const downloaded = await downloadHarkArtifact(req.accountId, {
          url: req.url,
          fileId: req.fileId,
          name: req.name,
          preview: req.preview,
          signal
        })
        return { ok: true, data: downloaded }
      }
      case 'call': {
        if (typeof req.path !== 'string' || !req.path.trim()) {
          return { ok: false, status: 400, message: 'path required' }
        }
        if (/^\/?messages\/pause-agent$/i.test(req.path)) {
          const requested = (req.body as { conversationId?: string } | undefined)?.conversationId
          const sessionId = harkProjectId(requested)
          if (requested !== undefined && !sessionId) return { ok: false, status: 400, message: 'Invalid conversationId' }
          cancelHarkWatch(req.accountId, sessionId)
          broadcast({
            type: 'activity',
            accountId: req.accountId,
            sessionId,
            activityCode: 'idle',
            busy: false
          })
        }
        const isConnector = /^\/?connectors\//i.test(req.path)
        try {
          const data = await callHarkApi(req.accountId, {
            method: req.method,
            path: req.path,
            query: req.query,
            body: req.body
          })
          if (isConnector) logHarkCall(req.path, req.body, data)
          // Answers to asks: log the outcome only (bodies hold passwords and codes).
          else if (/^\/?(secrets|messages\/tool-response)\b/i.test(req.path)) logHarkCall(req.path, null, { ok: true, keys: data && typeof data === 'object' ? Object.keys(data) : typeof data })
          return { ok: true, data }
        } catch (err) {
          if (isConnector) {
            const e = err as { status?: number; message?: string; body?: unknown }
            logHarkCall(req.path, req.body, { error: true, status: e.status, message: e.message, body: e.body })
          } else if (/^\/?(secrets|messages\/tool-response)\b/i.test(req.path)) {
            const e = err as { status?: number; message?: string }
            logHarkCall(req.path, null, { error: true, status: e.status, message: e.message })
          }
          throw err
        }
      }
      default:
        return { ok: false, status: 400, message: `Unknown op` }
    }
  } catch (error) {
    if (error instanceof HarkRequestTimeout && error.method === 'POST' && error.pathname === '/api/messages/send') {
      return { ok: false, status: 0, code: 'send-timeout', message: error.message }
    }
    if (error instanceof HarkApiError) {
      return {
        ok: false,
        status: error.status,
        message: error.message,
        body: typeof error.body === 'string' ? error.body : JSON.stringify(error.body)
      }
    }
    return {
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

let registered = false

export function registerHarkIpc(): void {
  if (registered) return
  registered = true

  onHarkLoginEvent((event) => {
    if (event.signedIn) {
      reloadAccountWebViews(event.accountId, harkWebViewUrlAfterSignIn)
      broadcast({
        type: 'login',
        accountId: event.accountId,
        signedIn: true as const,
        handle: event.handle,
        displayName: event.displayName
      })
      // Cookie names only — never values — for local samples after e2e.
      if (event.sessionCookieNames.length) {
        console.info(
          '[hark] session cookie names:',
          event.sessionCookieNames.join(', ')
        )
      }
    } else {
      broadcast({
        type: 'login',
        accountId: event.accountId,
        signedIn: false as const,
        windowClosed: event.windowClosed
      })
    }
  })

  ipcMain.handle(HARK_CHANNELS.openLogin, async (event, request: unknown) => {
    if (typeof request !== 'object' || request === null) throw new TypeError('Invalid hark openLogin')
    const req = request as HarkOpenLoginRequest
    if (typeof req.accountId !== 'string') throw new TypeError('Invalid accountId')
    await openHarkLoginWindow(req.accountId, ownerWindow(event))
    return statusFor(req.accountId)
  })

  ipcMain.handle(HARK_CHANNELS.cancelLogin, async (_event, accountId: unknown) => {
    if (typeof accountId !== 'string') throw new TypeError('Invalid accountId')
    await cancelHarkLogin(accountId)
    return statusFor(accountId)
  })

  ipcMain.handle(HARK_CHANNELS.authStatus, async (_event, accountId: unknown) => {
    if (typeof accountId !== 'string') throw new TypeError('Invalid accountId')
    return statusFor(accountId)
  })

  ipcMain.handle(HARK_CHANNELS.importCredentials, async (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null) {
      throw new TypeError('Invalid hark importCredentials request')
    }
    const req = request as HarkImportCredentialsRequest
    const targetId = typeof req.accountId === 'string' && req.accountId.trim() ? req.accountId.trim() : ''
    if (!targetId) throw new TypeError('accountId required')
    const hasProxy = loadAccountProxyUrl(targetId).then(Boolean).catch(() => true)
    return withHarkCredentials(targetId, async () => {
      const imported = await importHarkCredentials(targetId, req.rawInput ?? '', async () => {
        const probe = await probeHarkSession(targetId, { reportConnectionErrors: true })
        return 'signedIn' in probe ? null : probe.session
      })
      if (!imported) return { accountId: targetId, signedIn: false, hasProxy: await hasProxy }
      await completeHarkCredentialImport(targetId, imported)
      return { accountId: targetId, signedIn: true, ...extractHandle(imported), hasProxy: await hasProxy }
    })
  })

  ipcMain.handle(HARK_CHANNELS.clearAuth, async (_event, accountId: unknown) => {
    if (typeof accountId !== 'string' || !accountId.trim()) throw new TypeError('Invalid accountId')
    const id = accountId.trim()
    for (const request of activeRequests.values()) if (request.accountId === id) request.controller.abort()
    for (const watch of visibleProjects.values()) if (watch.accountId === id) watch.stop()
    void cancelHarkLogin(id, { clearIfEmpty: false })
    await withHarkCredentials(id, async () => {
      void cancelHarkLogin(id, { clearIfEmpty: false })
      await clearHarkAccount(id)
      knownAccounts.delete(id)
      broadcast({ type: 'login', accountId: id, signedIn: false as const })
    })
    return { accountId: id, signedIn: false }
  })

  ipcMain.handle(HARK_CHANNELS.rpc, async (event, request: unknown) => {
    if (typeof request !== 'object' || request === null) {
      return { ok: false as const, status: 0, message: 'Invalid hark rpc request' }
    }
    const req = request as HarkRequest
    if (typeof req.accountId !== 'string' || typeof req.op !== 'string') {
      return { ok: false as const, status: 0, message: 'accountId and op required' }
    }
    if (req.op === 'observeProject') {
      if (!harkProjectId(req.conversationId)) return { ok: false, status: 400, message: 'conversationId required' }
      observeProject(event, req)
      return { ok: true, data: null }
    }
    if (req.op === 'leaveProject') {
      visibleProjects.get(`${event.sender.id}:${req.subscription}`)?.stop()
      return { ok: true, data: null }
    }
    const requestId = typeof req.requestId === 'string' && req.requestId
    const key = requestId ? JSON.stringify([event.sender.id, req.accountId, requestId]) : undefined
    if (req.op === 'cancelRequest') {
      if (key) activeRequests.get(key)?.controller.abort()
      return { ok: true, data: null }
    }
    if (!key || !['pollReply', 'browserPreview', 'downloadArtifact', 'conversationSnapshot', 'mainConversation'].includes(req.op)) return runHarkRpc(req)
    if (activeRequests.has(key)) return { ok: false, status: 409, message: 'Hark request already active' }

    const controller = new AbortController()
    const abort = () => controller.abort()
    activeRequests.set(key, { accountId: req.accountId, controller })
    event.sender.once('destroyed', abort)
    event.sender.once('did-navigate', abort)
    try {
      return await runHarkRpc(req, controller.signal)
    } finally {
      activeRequests.delete(key)
      event.sender.off('destroyed', abort)
      event.sender.off('did-navigate', abort)
    }
  })
}
