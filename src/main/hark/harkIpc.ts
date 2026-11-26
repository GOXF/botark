import { currentHarkBrowser } from '@shared/harkBrowserPreview'
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
  getAuthSession,
  getConversationStatuses,
  getMainConversation,
  getProfile,
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
  type HarkUploadedAttachment
} from './harkClient'
import { cancelHarkLogin, completeHarkCredentialImport, onHarkLoginEvent, openHarkLoginWindow } from './harkLogin'
import { loadAccountProxyUrl } from '../muse/accountProxy'
import { guessMediaMimeFromName } from '../mediaMime'
import { probeHarkSession } from './harkSession'
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
    summary: tc.url || tc.command || tc.result
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

export function mapHarkRichWidgets(msg: HarkChatMessage): MuseRichWidgetView[] | undefined {
  if (!msg.actions || msg.actions.length === 0) return undefined
  return [
    {
      kind: 'text_with_button',
      widgetId: `hark_act_${msg.id}`,
      text: '',
      buttons: msg.actions.map((a) => ({
        label: a.label || `Connect ${a.connector ?? ''}`,
        actionText: a.connector ? `Connect ${a.connector}` : a.label,
        // The renderer asks Hark for the provider's auth link on click instead of posting the action text.
        ...(a.connector ? { command: `hark:connect:${a.connector}` } : {})
      }))
    }
  ]
}

function historyView(messages: HarkChatMessage[]) {
  return messages.map((m) => ({
    ...m, media: !/^user$/i.test(m.role) ? mapHarkMedia(m) : undefined,
    richWidgets: !/^user$/i.test(m.role) ? mapHarkRichWidgets(m) : undefined
  }))
}

const visibleProjects = new Map<number, { subscription: string; accountId: string; stop: () => void }>()
const activeRequests = new Map<string, { accountId: string; controller: AbortController }>()

function observeProject(event: IpcMainInvokeEvent, req: Extract<HarkRequest, { op: 'observeProject' }>) {
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
    if (visibleProjects.get(senderId)?.stop === stop) visibleProjects.delete(senderId)
  }
  const unregister = registerHarkViewStop(req.accountId, stop)
  const senderId = sender.id
  visibleProjects.set(senderId, { accountId: req.accountId, subscription: req.subscription, stop })
  sender.once('destroyed', stop)
  sender.once('did-navigate', stop)
  void (async () => {
    const session = await preparedSessionForAccount(req.accountId)
    const state = new HarkConversationSyncState()
    const onFrame = (frame: string) => {
      if (signal.aborted) return
      const before = state.historyRevision
      state.applyFrame(frame)
      if (state.historyRevision === before || timer) return
      timer = setTimeout(() => {
        timer = undefined
        if (signal.aborted || sender.isDestroyed()) return
        sender.send(HARK_CHANNELS.event, {
          type: 'projectHistory', accountId: req.accountId, conversationId: req.conversationId,
          subscription: req.subscription, messages: historyView(state.orderedMessages()),
          browserPreview: currentHarkBrowser(state.extractPanels())
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

async function statusFor(accountId: string): Promise<HarkAuthStatus> {
  const hasProxy = Boolean(await loadAccountProxyUrl(accountId).catch(() => true))
  return withHarkCredentials(accountId, async () => {
    const probe = await probeHarkSession(accountId, { reportConnectionErrors: true })
    if ('signedIn' in probe) return { accountId, signedIn: false, hasProxy }
    return { accountId, signedIn: true, handle: probe.handle, displayName: probe.displayName, hasProxy }
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
            narration: snap?.narration ?? null
          }
        }
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
        const watched = await watchHarkConversationSync(req.accountId, req.conversationId, {
          responseMessageId: req.responseMessageId === undefined ? undefined : String(req.responseMessageId),
          afterMessageIds: afterIds,
          timeoutMs: req.timeoutMs ?? 90_000,
          signal,
          onUpdate: (msg, syncState, done) => {
            const text = msg.content.trim()
            const tools = mapHarkTools(msg)
            const media = mapHarkMedia(msg)
            const richWidgets = mapHarkRichWidgets(msg)
            const activePhrase =
              msg.narration?.trim() ||
              msg.thought?.trim() ||
              syncState.narration?.trim() ||
              syncState.activeActivity?.trim() ||
              ''

            if (!done && activePhrase) {
              broadcast({
                type: 'activity',
                accountId: req.accountId,
                sessionId: req.conversationId,
                activityCode: 'thinking',
                activityText: activePhrase.slice(0, 120),
                busy: true
              })
            }

            if (!text && !tools?.length && !media?.length && !richWidgets?.length && !done) return
            broadcast({
              type: 'stream',
              accountId: req.accountId,
              sessionId: req.conversationId,
              conversationId: req.botId,
              messageId: `hark_${msg.id}`,
              text,
              done,
              ...(tools ? { tools } : {}),
              ...(media ? { media } : {}),
              ...(richWidgets ? { richWidgets } : {})
            })
          }
        })

        const finalReply = watched.reply
        return {
          ok: true,
          data: {
            conversationId: req.conversationId,
            outcome: watched.outcome,
            error: watched.error,
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
    void cancelHarkLogin(id, { clearIfEmpty: false })
    await withHarkCredentials(id, async () => {
      void cancelHarkLogin(id, { clearIfEmpty: false })
      await clearHarkAccount(id)
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
      const active = visibleProjects.get(event.sender.id)
      if (active?.accountId === req.accountId && active.subscription === req.subscription) active.stop()
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
