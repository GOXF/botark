/**
 * GOXF fork only: 「撤回」. No platform can delete a sent message, so recall
 * stops the turn, hides the bubble here, puts the text back in the composer,
 * and prefixes the next send with IGNORE_NOTE so the bot drops the old ask.
 * Recalled messages are matched by text + time, since history reloads swap
 * local ids for platform ids.
 */
import { create } from 'zustand'
import type { ChatMessage } from '@/types'
import { useBotStore } from '@/store/botStore'
import { composerDraft } from './goxfComposerDrafts'

export const IGNORE_NOTE = '（请忽略我上一条消息）'
const KEY = 'goxf.recall.v1'
const MATCH_MS = 2 * 60_000
const KEEP = 50

/** at = the message's time; until = when it was recalled, so later re-sends of the same text stay visible. */
interface Recalled { text: string; at: number; until: number }
interface RecallState {
  /** botId → recalled messages. */
  recalled: Record<string, Recalled[]>
  /** botIds whose next send carries IGNORE_NOTE. */
  pending: Record<string, true>
}

function load(): RecallState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '') as RecallState
    return { recalled: raw.recalled ?? {}, pending: raw.pending ?? {} }
  } catch {
    return { recalled: {}, pending: {} }
  }
}

export const useRecall = create<RecallState>(() => load())
useRecall.subscribe((s) => {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* quota: recall just won't survive a restart */ }
})

export function stripIgnoreNote(text: string): string {
  return text.startsWith(IGNORE_NOTE) ? text.slice(IGNORE_NOTE.length).replace(/^\s+/, '') : text
}

export function isRecalled(list: Recalled[] | undefined, m: ChatMessage): boolean {
  if (!list || m.role !== 'user') return false
  const text = m.text.trim()
  return list.some((r) => r.text === text && m.createdAt < r.until && Math.abs(r.at - m.createdAt) < MATCH_MS)
}

/** Put text into the bot's composer, mounted or not. */
export function refillComposer(botId: string, text: string): void {
  composerDraft(botId).text = text
  window.dispatchEvent(new CustomEvent('goxf:composer-refill', { detail: { botId, text } }))
}

export function recallMessage(m: ChatMessage): void {
  const store = useBotStore.getState()
  if (store.typing[m.botId]) void store.cancelGeneration(m.botId)
  const raw = m.text.trim()
  useRecall.setState((s) => ({
    recalled: { ...s.recalled, [m.botId]: [...(s.recalled[m.botId] ?? []), { text: raw, at: m.createdAt, until: Date.now() }].slice(-KEEP) },
    pending: { ...s.pending, [m.botId]: true }
  }))
  refillComposer(m.botId, stripIgnoreNote(raw))
}

export function clearIgnoreNote(botId: string): void {
  useRecall.setState((s) => {
    const { [botId]: _, ...rest } = s.pending
    return { pending: rest }
  })
}

/** Called on send: prefix the note once, then drop it. */
export function withIgnoreNote(botId: string, text: string): string {
  if (!useRecall.getState().pending[botId]) return text
  clearIgnoreNote(botId)
  return `${IGNORE_NOTE}\n${text}`
}
