import { HARK_DRAFT_SESSION } from '@shared/harkProjects'
import type { Bot, ChatMessage } from '@/types'

/**
 * GOXF perf: the renderer only keeps a display copy of each conversation.
 * Bots nobody looked at for a while drop all but their newest bubbles; the
 * full history reloads from the platform when the bot is opened again.
 */
export const TRIM_IDLE_AFTER_MS = 10 * 60_000
/** Lists at or below this length are left alone (avoids a reload for short chats). */
export const TRIM_ABOVE = 80
export const KEEP_WHEN_TRIMMED = 50

/** A local message still waiting on delivery (or Retry): never drop or replace it. */
export function hasUnsettledDelivery(list: readonly ChatMessage[]): boolean {
  return list.some((m) => m.delivery === 'sending' || m.delivery === 'accepted' || m.delivery === 'failed')
}

/** Platforms whose current conversation the store can fetch again by itself. */
export function canReloadHistory(bot: Pick<Bot, 'platformId' | 'activeSessionId' | 'selectedAgentId'>): boolean {
  switch (bot.platformId) {
    case 'meta-muse':
    case 'hermes':
    case 'antigravity':
      return Boolean(bot.activeSessionId)
    case 'hark':
      return Boolean(bot.activeSessionId) && bot.activeSessionId !== HARK_DRAFT_SESSION
    case 'grok':
      return Boolean(bot.selectedAgentId)
    case 'cue':
      return true
    default:
      return false // dot: history only loads from its side panel
  }
}

/**
 * Cut each candidate's list to its newest `keep` messages. Returns the same
 * `messages` object when nothing changed, plus the ids actually trimmed.
 */
export function trimMessages(
  messages: Record<string, ChatMessage[]>,
  candidates: Iterable<string>,
  keep = KEEP_WHEN_TRIMMED,
  above = TRIM_ABOVE
): { messages: Record<string, ChatMessage[]>; trimmed: string[] } {
  const trimmed: string[] = []
  let next = messages
  for (const botId of candidates) {
    const list = messages[botId]
    if (!list || list.length <= above || hasUnsettledDelivery(list)) continue
    if (next === messages) next = { ...messages }
    next[botId] = list.slice(-keep)
    trimmed.push(botId)
  }
  return { messages: next, trimmed }
}
