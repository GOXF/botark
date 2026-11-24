import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import type { SocketModeClient } from '@slack/socket-mode'
import type { WebClient, WebClientOptions } from '@slack/web-api'
import { createMutex } from '@shared/proxyPool'
import { SLACK_CHANNEL, SLACK_INBOUND, type SlackRequest, type SlackState } from '@shared/slack'
import { deleteVaultSecret, getVaultSecret, setVaultSecret } from '../securityVault'
import { readJsonFile, writeJsonAtomic } from '../jsonFile'
import { canPostToSlackBinding, routeSlackMessage, splitSlackText, type SlackBindingSnapshot } from './routing'

const key = 'internal.slack.tokens'
const exclusive = createMutex()
const REQUEST_TIMEOUT_MS = 10_000
const CONNECT_TIMEOUT_MS = 15_000
const DELIVERY_TTL_MS = 5 * 60_000
const MAX_DELIVERIES = 1_500
const webOptions: WebClientOptions = {
  timeout: REQUEST_TIMEOUT_MS,
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true
}

interface Preferences { teamId?: string; bindings: SlackBindingSnapshot[] }
interface Connection {
  socket: SocketModeClient
  api: WebClient
  controller: AbortController
  online: boolean
  availability: number
}
interface PendingDelivery {
  expiresAt: number
  ack: () => Promise<void>
  renderer: object
}

let prefs: Preferences
let connection: Connection | undefined
let generation = 0
let connecting: AbortController | undefined
let bindingGeneration = Date.now()
let saved = false
const pending = new Map<string, PendingDelivery>()
const received = new Map<string, number>()
let deliveryExpiry: ReturnType<typeof setTimeout> | undefined
const renderers = new WeakMap<BrowserWindow['webContents'], object>()
const configPath = () => join(app.getPath('userData'), 'slack-rooms.json')

function save(next: Preferences) {
  writeJsonAtomic(configPath(), next)
  prefs = next
}

function view(): SlackState {
  return { connected: connection?.online ?? false, saved, bindings: prefs.bindings }
}

function rememberThread(binding: SlackBindingSnapshot, thread: string) {
  if (binding.defaultThread || binding.thread) return
  save({
    ...prefs,
    bindings: prefs.bindings.map((b) => b === binding ? { ...b, defaultThread: thread } : b)
  })
}

async function withDeadline<T>(operation: Promise<T>, timeout: number, message: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout)
        if (signal) {
          abort = () => reject(signal.reason)
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        }
      })
    ])
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}

function detach(): Connection | undefined {
  const previous = connection
  connection = undefined
  previous?.controller.abort(new Error('Slack 连接已变更'))
  pending.clear()
  received.clear()
  clearTimeout(deliveryExpiry)
  deliveryExpiry = undefined
  return previous
}

async function disconnect(current: Connection | undefined): Promise<void> {
  if (!current) return
  await withDeadline(current.socket.disconnect(), 2_000, 'Slack 断开连接超时').catch(() => undefined)
}

export async function stopSlack() {
  const previous = await exclusive(() => {
    cancelConnectionAttempt()
    return detach()
  })
  await disconnect(previous)
}

function cancelConnectionAttempt(): void {
  generation++
  connecting?.abort(new Error('Slack 连接请求已取消'))
  connecting = undefined
}

function rendererGeneration(contents: BrowserWindow['webContents']): object {
  let renderer = renderers.get(contents)
  if (!renderer) {
    renderer = {}
    renderers.set(contents, renderer)
    contents.on?.('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) renderers.set(contents, {})
    })
  }
  return renderer
}

function pruneDeliveries(now: number) {
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(id)
  }
  for (const [id, expires] of received) {
    if (expires <= now) received.delete(id)
  }
}

function scheduleDeliveryExpiry() {
  if (deliveryExpiry) return
  const expires = pending.values().next().value?.expiresAt ?? received.values().next().value
  if (expires === undefined) return
  const nextReceiptExpiry = received.values().next().value ?? expires
  deliveryExpiry = setTimeout(() => {
    deliveryExpiry = undefined
    pruneDeliveries(Date.now())
    scheduleDeliveryExpiry()
  }, Math.max(1, Math.min(expires, nextReceiptExpiry) - Date.now()))
  deliveryExpiry.unref()
}

function installEvents(
  current: Connection,
  owner: () => BrowserWindow | null,
  teamId: string,
  botUser: string
): void {
  const changeOnline = (online: boolean) => {
    if (current.online !== online) {
      current.online = online
      current.availability++
    }
  }
  current.socket.on('connected', () => changeOnline(true))
  current.socket.on('disconnected', () => changeOnline(false))
  current.socket.on('slack_event', (envelope) => {
    const ack = async () => {
      try { await envelope.ack() } catch { /* Slack can redeliver an unacknowledged event. */ }
    }
    void exclusive(() => {
      if (connection !== current || envelope.type !== 'events_api' || envelope.body.team_id !== teamId) {
        return { acknowledge: true }
      }
      const message = routeSlackMessage(prefs.bindings, envelope.body.event ?? {}, botUser)
      const now = Date.now()
      pruneDeliveries(now)
      if (!message || received.has(message.id)) return { acknowledge: true }
      const win = owner()
      if (!win || win.isDestroyed() || win.webContents.isDestroyed?.()) return
      const renderer = rendererGeneration(win.webContents)
      const previous = pending.get(message.id)
      if (previous?.renderer === renderer) {
        // Keep the newest acknowledgment target, since the old socket may have retired.
        previous.ack = ack
        return { acknowledge: false }
      }
      if (!previous && pending.size >= MAX_DELIVERIES) return
      const binding = prefs.bindings.find((b) => b.roomId === message.roomId)
      if (!binding) return
      rememberThread(binding, message.thread)
      pending.delete(message.id)
      pending.set(message.id, {
        ack, expiresAt: now + DELIVERY_TTL_MS, renderer
      })
      scheduleDeliveryExpiry()
      try {
        win.webContents.send(SLACK_INBOUND, message)
      } catch (error) {
        pending.delete(message.id)
        throw error
      }
      return { acknowledge: false }
    }).then((result) => {
      if (result?.acknowledge) void ack()
    }).catch(() => undefined)
  })
}

async function connect(owner: () => BrowserWindow | null, appToken?: string, botToken?: string) {
  const attempt = await exclusive(() => {
    if (!appToken && !botToken && connection?.online) return undefined
    cancelConnectionAttempt()
    const controller = new AbortController()
    connecting = controller
    return { revision: generation, controller }
  })
  if (attempt === undefined) return
  const assertAttempt = () => {
    if (generation !== attempt.revision) throw new Error('Slack 连接请求已取消')
  }
  const { signal } = attempt.controller
  let candidate: Connection | undefined
  try {
    const stored = !appToken && !botToken ? await getVaultSecret(key) : null
    assertAttempt()
    const tokens = stored ? JSON.parse(stored) as { appToken: string; botToken: string } : { appToken, botToken }
    if (!tokens.appToken?.startsWith('xapp-') || !tokens.botToken?.startsWith('xoxb-')) throw new Error('需要 App Token 和 Bot Token')

    const [{ WebClient }, { SocketModeClient }] = await Promise.all([import('@slack/web-api'), import('@slack/socket-mode')])
    assertAttempt()
    const api = new WebClient(tokens.botToken, {
      ...webOptions,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) })
    })
    const auth = await withDeadline(api.auth.test(), REQUEST_TIMEOUT_MS, 'Slack 身份验证超时', signal)
    assertAttempt()
    const { team_id: teamId, user_id: botUser } = auth
    if (!teamId || !botUser) throw new Error('Slack 无法确认工作区或应用身份')
    const assertTeam = () => {
      if (prefs.teamId && prefs.teamId !== teamId && prefs.bindings.length) throw new Error('请先解除旧 Slack 工作区绑定')
    }
    assertTeam()

    const current: Connection = {
      socket: new SocketModeClient({ appToken: tokens.appToken, clientOptions: webOptions }),
      api,
      controller: attempt.controller,
      online: false,
      availability: 0
    }
    candidate = current
    installEvents(current, owner, teamId, botUser)
    await withDeadline(current.socket.start(), CONNECT_TIMEOUT_MS, 'Slack 实时连接超时', signal)
    const previous = await exclusive(async () => {
      assertAttempt()
      assertTeam()
      if (!stored) await setVaultSecret(key, JSON.stringify(tokens))
      save({ ...prefs, teamId })
      saved = true
      connecting = undefined
      const previous = detach()
      connection = current
      return previous
    })
    await disconnect(previous)
  } catch (error) {
    attempt.controller.abort(error)
    await disconnect(candidate)
    throw error
  } finally {
    await exclusive(() => {
      if (connecting === attempt.controller) connecting = undefined
    })
  }
}

type PostRequest = Extract<SlackRequest, { op: 'post' }> & { bindingGeneration?: number }

async function publish(req: PostRequest): Promise<void> {
  const current = connection
  const binding = prefs.bindings.find((item) => item.roomId === req.roomId)
  if (!binding) {
    if (req.channel) throw new Error('此话题的原 Slack 绑定已变更')
    return
  }
  if (!canPostToSlackBinding(binding, req)) throw new Error('此话题的原 Slack 绑定已变更')
  if (!current?.online) throw new Error('Slack 已断开，消息保留在 BotArk')
  const availability = current.availability
  const { channel, bindingGeneration } = binding
  const currentBinding = () => {
    if (connection !== current || !current.online || current.availability !== availability) {
      throw new Error('Slack 连接已变更，消息保留在 BotArk')
    }
    const latest = prefs.bindings.find((item) => item.roomId === req.roomId)
    if (!latest || latest.bindingGeneration !== bindingGeneration || latest.channel !== channel || latest.thread !== binding.thread) {
      throw new Error('此话题的原 Slack 绑定已变更')
    }
    return latest
  }
  let thread = binding.thread ?? req.thread ?? binding.defaultThread
  for (const text of splitSlackText(req.text)) {
    currentBinding()
    const sent = await withDeadline(current.api.chat.postMessage({
      channel, thread_ts: thread, text, unfurl_links: false, unfurl_media: false, mrkdwn: false
    }), REQUEST_TIMEOUT_MS, 'Slack 发送超时', current.controller.signal)
    if (!thread && sent.ts) {
      thread = sent.ts
      const firstThread = thread
      await exclusive(() => rememberThread(currentBinding(), firstThread))
    }
  }
}

export function registerSlackIpc(owner: () => BrowserWindow | null) {
  ipcMain.handle(SLACK_CHANNEL, async (event, req: SlackRequest & { bindingGeneration?: number }) => {
    const win = owner()
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Desktop window required')
    if (!prefs) {
      prefs = readJsonFile<Preferences>(configPath(), { bindings: [] }, (raw) => Array.isArray((raw as Preferences)?.bindings))
      prefs = {
        ...prefs,
        bindings: prefs.bindings.map((binding) => ({ ...binding, bindingGeneration: ++bindingGeneration }))
      }
    }
    switch (req.op) {
      case 'received': {
        const delivery = await exclusive(() => {
          const now = Date.now()
          pruneDeliveries(now)
          const item = pending.get(req.id)
          if (!item) return
          received.set(req.id, now + DELIVERY_TTL_MS)
          if (received.size > MAX_DELIVERIES) received.delete(received.keys().next().value!)
          pending.delete(req.id)
          scheduleDeliveryExpiry()
          return item
        })
        if (delivery) void delivery.ack()
        break
      }
      case 'status': {
        await exclusive(async () => {
          saved = Boolean(await getVaultSecret(key))
        })
        break
      }
      case 'connect':
        await connect(owner, req.appToken, req.botToken)
        break
      case 'disconnect':
        await stopSlack()
        break
      case 'forget': {
        let previous: Connection | undefined
        try {
          await exclusive(async () => {
            cancelConnectionAttempt()
            previous = detach()
            await deleteVaultSecret(key)
            save({ bindings: [] })
            saved = false
          })
        } finally {
          await disconnect(previous)
        }
        break
      }
      case 'bind':
        await exclusive(() => {
          if (!connection?.online) throw new Error('请先连接 Slack')
          if (!/^[CG][A-Z0-9]+$/.test(req.channel) || (req.thread && !/^\d+\.\d+$/.test(req.thread))) {
            throw new Error('请输入频道 ID 和有效的线程时间戳')
          }
          const others = prefs.bindings.filter((b) => b.roomId !== req.roomId)
          if (others.some((b) => b.channel === req.channel && (!b.thread || !req.thread || b.thread === req.thread))) {
            throw new Error('此频道或线程已绑定其他群聊')
          }
          save({ ...prefs, bindings: [...others, {
            roomId: req.roomId, channel: req.channel, thread: req.thread, bindingGeneration: ++bindingGeneration
          }] })
        })
        break
      case 'unbind':
        await exclusive(() => save({ ...prefs, bindings: prefs.bindings.filter((b) => b.roomId !== req.roomId) }))
        break
      case 'post':
        await publish(req)
        break
    }
    return view()
  })
}
