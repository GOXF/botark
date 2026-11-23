import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  HARK_CHANNELS,
  type HarkAuthStatus,
  type HarkImportCredentialsRequest,
  type HarkOpenLoginRequest,
  type HarkRpcRequest,
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
  getAuthSession,
  getConversationStatuses,
  getMainConversation,
  getProfile,
  harkReplySnippet,
  importHarkCredentials,
  isHarkReplyDone,
  listConversations,
  sendMessage,
  timezoneName,
  uploadHarkAttachment,
  watchHarkConversationSync,
  extractHandle,
  HarkApiError,
  HarkConversationSyncState,
  preparedSessionForAccount,
  readHarkStream,
  registerHarkViewStop,
  type HarkChatMessage,
  type HarkUploadedAttachment
} from './harkClient'
import { harkTurnBusy } from './harkBusy'
import { cancelHarkLogin, closeHarkLoginWindow, onHarkLoginEvent, openHarkLoginWindow } from './harkLogin'
import { loadAccountProxyUrl } from '../muse/accountProxy'
import { guessMediaMimeFromName } from '../mediaMime'
import { logHarkSessionDebug, probeHarkSession } from './harkSession'
import { harkWebViewUrlAfterSignIn } from './harkWebView'
import { reloadAccountWebViews } from '../webViewIpc'
import { harkCreateProjectBody } from '@shared/harkProjects'

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
  if (!msg.actions || msg.actions.length === 0) return undefined
  return [
    {
      kind: 'text_with_button',
      widgetId: `hark_act_${msg.id}`,
      text: '',
      buttons: msg.actions.map((a) => ({
        label: a.label || `Connect ${a.connector ?? ''}`,
        actionText: a.connector ? `Connect ${a.connector}` : a.label
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

const visibleProjects = new Map<number, { subscription: string; accountId: string; stop: () => void }>()

function observeProject(event: IpcMainInvokeEvent, req: Extract<HarkRpcRequest, { op: 'observeProject' }>) {
  const sender = event.sender
  visibleProjects.get(sender.id)?.stop()
  const controller = new AbortController()
  const signal = controller.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    controller.abort()
    unregister()
    clearTimeout(timer)
    sender.off('destroyed', stop)
    sender.off('did-navigate', stop)
    visibleProjects.delete(senderId)
  }
  const unregister = registerHarkViewStop(req.accountId, stop)
  const senderId = sender.id
  visibleProjects.set(senderId, { accountId: req.accountId, subscription: req.subscription, stop })
  sender.once('destroyed', stop)
  sender.once('did-navigate', stop)
  const update = (messages: HarkChatMessage[], live?: { busy: boolean; text: string }) => {
    if (!signal.aborted && !sender.isDestroyed()) sender.send(HARK_CHANNELS.event, {
      type: 'projectHistory', accountId: req.accountId, conversationId: req.conversationId,
      subscription: req.subscription, messages: historyView(messages), live
    })
  }
  void (async () => {
    const session = await preparedSessionForAccount(req.accountId)
    const manager = randomUUID()
    let dial = 'initial'
    const state = new HarkConversationSyncState()
    while (!signal.aborted) {
      try {
        await readHarkStream(session, req.conversationId, manager, dial, signal, (frame) => {
          if (state.applyFrame(frame) && !timer) timer = setTimeout(() => {
            timer = undefined
            update(state.orderedMessages(), state.liveStatus())
          }, 150)
        })
      } catch {
        if (!signal.aborted) {
          const snapshot = await fetchConversationSnapshotSummary(req.accountId, req.conversationId).catch(() => null)
          if (snapshot) {
            const text = (snapshot.narration || snapshot.activeActivity || '').trim()
            update(snapshot.messages, text ? { busy: true, text: text.slice(0, 120) } : state.liveStatus())
          }
        }
      }
      dial = 'reconnect'
      await delay(3000, undefined, { signal })
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
  const st = await statusFor(accountId).catch(() => null)
  if (!st || st.signedIn === before) return
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
  const probe = await probeHarkSession(accountId, { reportConnectionErrors: true })
  if ('signedIn' in probe) {
    knownAccounts.set(accountId, false)
    return { accountId, signedIn: false, hasProxy }
  }
  knownAccounts.set(accountId, true)
  return {
    accountId,
    signedIn: true,
    handle: probe.handle,
    displayName: probe.displayName,
    hasProxy
  }
}

async function runHarkRpc(req: HarkRpcRequest): Promise<HarkRpcResponse> {
  try {
    switch (req.op) {
      case 'authStatus':
        return { ok: true, data: await statusFor(req.accountId) }
      case 'getSession': {
        const session = await getAuthSession(req.accountId)
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
        const conversationId = conversationIdFromPayload(result)
        if (!conversationId) throw new Error('Hark returned no project ID')
        return { ok: true, data: { conversationId } }
      }
      case 'conversationSnapshot':
      case 'mainConversation': {
        const data = req.op === 'mainConversation'
          ? await getMainConversation(req.accountId, req.timezone ?? timezoneName()) : null
        const convId = req.op === 'conversationSnapshot' ? req.conversationId : conversationIdFromPayload(data)
        const snap = convId ? await fetchConversationSnapshotSummary(req.accountId, convId) : null
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
            narration: snap?.narration ?? null
          }
        }
      }
      case 'conversationStatus':
        return { ok: true, data: await getConversationStatuses(req.accountId) }
      case 'sendMessage': {
        if (typeof req.conversationId !== 'string' || !req.conversationId) {
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
        if (typeof req.conversationId !== 'string' || !req.conversationId) {
          return { ok: false, status: 400, message: 'conversationId required' }
        }
        const afterIds = new Set(req.afterMessageIds ?? [])
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
          msg?.thought?.trim() ||
          ''
        // Turn messages as last shown (by object: sync state replaces a message on change).
        const shown = new Map<string, HarkChatMessage>()
        // The tail showed Hark as busy, so it must close the turn (done + idle) when it ends.
        let tailOpen = false
        const watched = await watchHarkConversationSync(req.accountId, req.conversationId, {
          responseMessageId: req.responseMessageId,
          afterMessageIds: afterIds,
          timeoutMs: req.timeoutMs ?? 90_000,
          onUpdate: (msg, syncState) => {
            const replyDone = isHarkReplyDone(msg)
            const busy = harkTurnBusy(syncState, afterIds)
            // A finished reply is only "done" once Hark's turn is idle too.
            const done = replyDone && !busy
            const activePhrase = livePhrase(syncState, msg) || (replyDone && busy ? '等待任务完成…' : '')
            if (!done && activePhrase) activity(activePhrase)
            const hasPayload =
              msg.content.trim() || msg.toolCalls?.length || msg.artifacts?.length || msg.actions?.length
            if (!hasPayload && !done) return
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
              if (m.content.trim() || m.toolCalls?.length || m.artifacts?.length || m.actions?.length) streamOf(m, ended)
            }
            if (ended && tailOpen) activity('')
          }
        })
        // Hark still works on this turn: the tail keeps the status line and clears it at the end.
        const tailing = watched.tailing
        if (tailing) tailOpen = true
        else activity('')

        const finalReply = watched.reply
        if (
          finalReply &&
          (finalReply.content.trim() ||
            finalReply.toolCalls?.length ||
            finalReply.actions?.length ||
            finalReply.artifacts?.length)
        ) {
          const { tools, media, richWidgets } = streamOf(finalReply, !tailing)
          return {
            ok: true,
            data: {
              conversationId: req.conversationId,
              messages: watched.messages,
              tailing,
              reply: {
                ...finalReply,
                id: `hark_${finalReply.id}`,
                tools,
                media,
                richWidgets
              }
            }
          }
        }
        if (req.botId) {
          broadcast({
            type: 'stream',
            accountId: req.accountId,
            sessionId: req.conversationId,
            conversationId: req.botId,
            messageId: req.responseMessageId ? `hark_${req.responseMessageId}` : 'hark_timeout',
            text: '',
            done: true
          })
        }
        return {
          ok: true,
          data: {
            conversationId: req.conversationId,
            messages: watched.messages,
            reply: null,
            timedOut: true
          }
        }
      }
      case 'downloadArtifact': {
        const downloaded = await downloadHarkArtifact(req.accountId, {
          url: req.url,
          fileId: req.fileId,
          name: req.name
        })
        return { ok: true, data: downloaded }
      }
      case 'call': {
        if (typeof req.path !== 'string' || !req.path.trim()) {
          return { ok: false, status: 400, message: 'path required' }
        }
        if (/pause-agent|stop-tool/i.test(req.path)) {
          const sessionId = (req.body as { conversationId?: string } | undefined)?.conversationId
          cancelHarkWatch(req.accountId, sessionId)
          broadcast({
            type: 'activity',
            accountId: req.accountId,
            activityCode: 'idle',
            busy: false
          })
        }
        const data = await callHarkApi(req.accountId, {
          method: req.method,
          path: req.path,
          query: req.query,
          body: req.body
        })
        return { ok: true, data }
      }
      default:
        return { ok: false, status: 400, message: `Unknown op` }
    }
  } catch (error) {
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
    const imported = await importHarkCredentials(targetId, req.rawInput ?? '')
    if (!imported) {
      return { accountId: targetId, signedIn: false }
    }
    const st = await statusFor(targetId)
    if (st.signedIn) {
      if (!closeHarkLoginWindow(targetId)) {
        reloadAccountWebViews(targetId, harkWebViewUrlAfterSignIn)
      }
      broadcast({
        type: 'login',
        accountId: targetId,
        signedIn: true as const,
        handle: st.handle,
        displayName: st.displayName
      })
    }
    return st
  })

  ipcMain.handle(HARK_CHANNELS.clearAuth, async (_event, accountId: unknown) => {
    if (typeof accountId !== 'string' || !accountId.trim()) throw new TypeError('Invalid accountId')
    for (const watch of visibleProjects.values()) if (watch.accountId === accountId.trim()) watch.stop()
    await clearHarkAccount(accountId.trim())
    knownAccounts.delete(accountId.trim())
    broadcast({
      type: 'login',
      accountId: accountId.trim(),
      signedIn: false as const
    })
    return { accountId: accountId.trim(), signedIn: false }
  })

  ipcMain.handle(HARK_CHANNELS.rpc, async (event, request: unknown) => {
    if (typeof request !== 'object' || request === null) {
      return { ok: false as const, status: 0, message: 'Invalid hark rpc request' }
    }
    const req = request as HarkRpcRequest
    if (typeof req.accountId !== 'string' || typeof req.op !== 'string') {
      return { ok: false as const, status: 0, message: 'accountId and op required' }
    }
    if (req.op === 'observeProject') {
      observeProject(event, req)
      return { ok: true, data: null }
    }
    if (req.op === 'leaveProject') {
      const active = visibleProjects.get(event.sender.id)
      if (active?.subscription === req.subscription) active.stop()
      return { ok: true, data: null }
    }
    return runHarkRpc(req)
  })
}
