import type { AdapterEvent } from '@adapters/types'
import type { Bot } from '@/types'

export function getEventBot(
  bots: readonly Bot[],
  accountId: string,
  conversationId?: string,
  sessionId?: string
): Bot | undefined {
  if (conversationId?.startsWith('room-turn-')) return
  const matches = (bot: Bot) => bot.activeAccountId === accountId &&
    (!sessionId || !bot.activeSessionId || bot.activeSessionId === sessionId)
  // Adapters use accountId only when there is no explicit bot ID.
  return conversationId && conversationId !== accountId
    ? bots.find((bot) => bot.id === conversationId && matches(bot))
    : bots.find(matches)
}

export function belongsToSelectedSession(event: AdapterEvent, bots: Bot[]): boolean {
  switch (event.type) {
    case 'message': {
      const message = event.message
      return Boolean(getEventBot(bots, message.accountId, message.conversationId, message.sessionId))
    }
    case 'typing':
    case 'message_delta':
      return Boolean(getEventBot(bots, event.accountId, event.conversationId, event.sessionId))
    case 'activity':
      return Boolean(getEventBot(bots, event.accountId, undefined, event.sessionId))
    default:
      return true
  }
}
