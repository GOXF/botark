import type { PersistStorage, StorageValue } from "zustand/middleware"
import type { BotAccount, ChatMessage } from "@/types"

/**
 * Upper bound for one adapter `sendMessage` call. Adapters wait for the reply
 * inside that call (Muse up to ~10 min, Dot 5 min, Grok/Hark 90 s), so this
 * only catches a call that never settles at all.
 */
export const SEND_HARD_TIMEOUT_MS = 12 * 60_000

export const SEND_TIMEOUT_TEXT = "发送超时，可能已经送达；重试前先确认对方是否收到"
export const SEND_STILL_PENDING_TEXT = "发送超时，可能已经送达；正在等待原发送完成"
export const INTERRUPTED_SEND_TEXT = "应用关闭时还没确认送达，可能已经发出；重试前先确认"
export const INTERRUPTED_REPLY_TEXT = "已送达，但应用关闭时回复还没收完"
export const ACCEPTED_THEN_FAILED_TEXT = "已送达，但等待回复时出错；重发前先确认对方是否已回复"

/**
 * Delivery state after `sendMessage` failed. Once the platform accepted the
 * message it is never "failed" (Retry would double-send), only "no-reply".
 */
export function deliveryAfterError(
  accepted: boolean,
  kind: "no-reply" | "timeout" | "other",
  detail: string
): { delivery: "failed" | "no-reply"; error: string } {
  if (kind === "no-reply") return { delivery: "no-reply", error: detail }
  if (accepted) return { delivery: "no-reply", error: kind === "timeout" ? ACCEPTED_THEN_FAILED_TEXT : `${ACCEPTED_THEN_FAILED_TEXT}（${detail}）` }
  return { delivery: "failed", error: detail }
}

export const ATTACHMENTS_LOST_TEXT = "附件在重启后已不在内存中，请重新添加后再发送"

/** Attachments whose bytes were not persisted cannot be re-sent after a restart. */
export function hasLostAttachments(message: Pick<ChatMessage, "attachments">): boolean {
  return Boolean(message.attachments?.some((a) => !a.dataBase64))
}

/** One delivery per message at a time: a double-clicked Retry must not send twice. */
export function createInFlightSet(): { enter(id: string): boolean; leave(id: string): void } {
  const ids = new Set<string>()
  return {
    enter(id) {
      if (ids.has(id)) return false
      ids.add(id)
      return true
    },
    leave(id) {
      ids.delete(id)
    }
  }
}

/** Hold the send slot until the transport settles, including after a UI timeout. */
export function createDeliveryAttempts() {
  const attempts = new Map<string, symbol>()
  return {
    begin(key: string) {
      if (attempts.has(key)) return
      const id = Symbol()
      attempts.set(key, id)
      return id
    },
    isCurrent: (key: string, id: symbol) => attempts.get(key) === id,
    finish(key: string, id: symbol) {
      if (attempts.get(key) === id) attempts.delete(key)
    }
  }
}

export class SendTimeoutError extends Error {
  constructor() {
    super(SEND_TIMEOUT_TEXT)
    this.name = "SendTimeoutError"
  }
}

/**
 * Race `promise` against a timer. If the timer wins, reject with
 * SendTimeoutError; a late result still reaches `onLate` so the caller can
 * correct the state it already showed.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onLate?: (outcome: { ok: true; value: T } | { ok: false; error: unknown }) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      reject(new SendTimeoutError())
    }, ms)
    promise.then(
      (value) => {
        if (timedOut) return onLate?.({ ok: true, value })
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (timedOut) return onLate?.({ ok: false, error })
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * Clean state loaded from disk: nothing can still be in flight after a
 * restart, so a persisted `sending` message or `pending` account would
 * otherwise stay stuck forever (connectAccount bails while `pending`).
 */
export function sanitizePersisted<
  S extends { messages?: Record<string, ChatMessage[]>; accounts?: Record<string, BotAccount> }
>(state: S): S {
  let messages = state.messages
  if (messages) {
    let changed = false
    const next: Record<string, ChatMessage[]> = {}
    for (const [botId, list] of Object.entries(messages)) {
      if (!Array.isArray(list)) continue
      const fixed = list.map((m) => {
        if (m.delivery === "accepted") {
          changed = true
          return { ...m, delivery: "no-reply" as const, error: INTERRUPTED_REPLY_TEXT }
        }
        if (m.delivery === "no-reply" && m.error === SEND_STILL_PENDING_TEXT) {
          changed = true
          return { ...m, error: INTERRUPTED_SEND_TEXT }
        }
        if (m.delivery !== "sending") return m
        changed = true
        return { ...m, delivery: "failed" as const, error: INTERRUPTED_SEND_TEXT }
      })
      next[botId] = fixed
    }
    if (changed || Object.keys(next).length !== Object.keys(messages).length) messages = next
  }
  let accounts = state.accounts
  if (accounts) {
    let changed = false
    const next: Record<string, BotAccount> = {}
    for (const [id, acc] of Object.entries(accounts)) {
      if (acc && (acc.pending || acc.status === "busy")) {
        changed = true
        next[id] = { ...acc, pending: false, status: acc.status === "busy" ? "offline" : acc.status }
      } else if (acc) {
        next[id] = acc
      }
    }
    if (changed) accounts = next
  }
  if (messages === state.messages && accounts === state.accounts) return state
  return { ...state, messages, accounts }
}

/** Most recent messages kept on disk per bot; older ones reload from the platform. */
export const PERSISTED_MESSAGES_PER_BOT = 400

/**
 * What goes to localStorage: no attachment bytes (a single 5 MB image used
 * to blow the ~5 MB quota, making every later save throw) and only the
 * newest messages per bot.
 */
export function toPersistedMessages(
  messages: Record<string, ChatMessage[]>,
  maxPerBot = PERSISTED_MESSAGES_PER_BOT
): Record<string, ChatMessage[]> {
  const out: Record<string, ChatMessage[]> = {}
  for (const [botId, list] of Object.entries(messages)) {
    const recent = list.length > maxPerBot ? list.slice(-maxPerBot) : list
    out[botId] = recent.map((m) =>
      m.attachments?.some((a) => a.dataBase64)
        ? { ...m, attachments: m.attachments.map(({ dataBase64: _bytes, ...rest }) => rest) }
        : m
    )
  }
  return out
}

const QUOTA_FALLBACK_BYTES = 4 * 1024 * 1024
const OMITTED_BODY = '[Message body omitted from local history]'

function tryCompactWorkspace(rawJson: string, write: (value: string) => void): boolean {
  try {
    const parsed = JSON.parse(rawJson) as {
      state?: { messages?: Record<string, ChatMessage[]> }
      version?: number
    }
    if (!parsed?.state?.messages || typeof parsed.state.messages !== 'object') return false
    const histories = Object.entries(parsed.state.messages)
    const limits = [
      { count: Infinity, text: 64 * 1024, html: Infinity, bytes: QUOTA_FALLBACK_BYTES },
      { count: 120, text: 8 * 1024, html: Infinity, bytes: QUOTA_FALLBACK_BYTES / 2 },
      { count: 30, text: 2048, html: 8192, bytes: QUOTA_FALLBACK_BYTES / 4 },
      { count: 30, text: 256, html: 0, bytes: 128 * 1024 },
      { count: 1, text: 0, html: 0, bytes: 32 * 1024 },
      { count: 0, text: 0, html: 0, bytes: QUOTA_FALLBACK_BYTES }
    ]
    for (const limit of limits) {
      const messages: Record<string, ChatMessage[]> = {}
      if (limit.count > 0) {
        for (const [botId, list] of histories) {
          if (!Array.isArray(list)) continue
          messages[botId] = list.slice(-limit.count).map((m) => {
            const rawText = typeof m.text === 'string' ? m.text : ''
            return {
              ...m,
              text: rawText.length > limit.text ? `${OMITTED_BODY}\n${rawText.slice(0, limit.text)}` : rawText,
              media: m.media?.filter((part) => !/^data:/i.test(part.path)),
              richWidgets: m.richWidgets?.filter((w) => w.kind !== 'html' || w.html.length <= limit.html)
            }
          })
        }
      }
      const value = JSON.stringify({ ...parsed, state: { ...parsed.state, messages } })
      // Budget the entire serialized snapshot across bots, including JSON escaping.
      if ((limit.count > 0 && value.length * 2 > limit.bytes) || value === rawJson) continue
      try {
        write(value)
        return true
      } catch {
        /* try the next smaller snapshot */
      }
    }
  } catch {
    /* The value is not a workspace snapshot. */
  }
  return false
}

/**
 * localStorage that never throws out of Zustand's writes. A deferred value
 * lets the debounced path coalesce serialization as well as storage writes.
 */
export function createSafeStorage(
  backing: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined,
  onError: (error: unknown) => void = () => undefined,
  { debounceMs = 0 }: { debounceMs?: number } = {}
) {
  type Value = string | (() => string)
  const pending = new Map<string, Value>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const write = (name: string, value: Value) => {
    try {
      const store = backing()
      if (!store) return
      const serialized = typeof value === 'string' ? value : value()
      try {
        store.setItem(name, serialized)
      } catch (error) {
        const quota = error instanceof Error && (error.name === 'QuotaExceededError' || error.message.includes('QuotaExceededError'))
        if (!quota || !tryCompactWorkspace(serialized, (snapshot) => store.setItem(name, snapshot))) throw error
      }
    } catch (error) {
      onError(error)
    }
  }
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    for (const [name, value] of pending) {
      pending.delete(name)
      write(name, value)
    }
  }
  return {
    flush,
    getItem: (name: string) => {
      try {
        const queued = pending.get(name)
        if (queued !== undefined) {
          pending.delete(name)
          write(name, queued)
        }
        return backing()?.getItem(name) ?? null
      } catch (error) {
        onError(error)
        return null
      }
    },
    setItem: (name: string, value: Value) => {
      if (debounceMs <= 0) return write(name, value)
      pending.set(name, value)
      clearTimeout(timer)
      timer = setTimeout(flush, debounceMs)
    },
    removeItem: (name: string) => {
      pending.delete(name)
      if (pending.size === 0) clearTimeout(timer)
      try {
        backing()?.removeItem(name)
      } catch (error) {
        onError(error)
      }
    }
  }
}

/**
 * A bot reply arrived: the newest user message still flagged `no-reply`
 * did get an answer after all.
 */
export function clearNoReplyFlag(list: ChatMessage[], accountId?: string): ChatMessage[] {
  // GOXF: a reply answers every user message sent since the previous reply (people send a thought in
  // pieces and Hark answers them together), so clear the flag on all of them, not only the newest.
  let next = list
  let sawUser = false
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]!
    if (accountId !== undefined && m.accountId !== accountId) continue
    if (m.role !== "user") {
      if (sawUser) break
      continue
    }
    sawUser = true
    if (m.delivery !== "no-reply" && m.delivery !== "accepted") continue
    if (next === list) next = list.slice()
    next[i] = { ...m, delivery: "sent", error: undefined }
  }
  return next
}

/**
 * Coalesce persist writes. zustand serialises the whole workspace on every
 * `set()`, i.e. once per streamed delta; only the newest value is written,
 * at most once per `ms`. Call `flush` before the page goes away.
 */
export function deferWrites<S>(storage: PersistStorage<S>, ms: number): PersistStorage<S> & { flush(): void } {
  let pending: { name: string; value: StorageValue<S> } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    const next = pending
    pending = null
    if (next) storage.setItem(next.name, next.value)
  }
  return {
    getItem: (name) => storage.getItem(name),
    setItem: (name, value) => {
      if (pending && pending.name !== name) flush()
      pending = { name, value }
      if (!timer) timer = setTimeout(flush, ms)
    },
    removeItem: (name) => {
      if (pending?.name === name) pending = null
      return storage.removeItem(name)
    },
    flush
  }
}
