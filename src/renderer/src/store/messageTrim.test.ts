import { describe, expect, it } from 'vitest'
import { HARK_DRAFT_SESSION } from '@shared/harkProjects'
import type { ChatMessage } from '@/types'
import { canReloadHistory, hasUnsettledDelivery, KEEP_WHEN_TRIMMED, TRIM_ABOVE, trimMessages } from './messageTrim'

const msgs = (botId: string, n: number, patch: Partial<ChatMessage> = {}): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${botId}_${i}`,
    botId,
    accountId: 'acc',
    role: i % 2 ? 'bot' : 'user',
    text: `m${i}`,
    createdAt: i,
    ...patch
  }))

describe('trimMessages', () => {
  it('keeps only the newest messages of long candidate lists', () => {
    const messages = { a: msgs('a', TRIM_ABOVE + 20), b: msgs('b', TRIM_ABOVE + 20) }
    const out = trimMessages(messages, ['a'])
    expect(out.trimmed).toEqual(['a'])
    expect(out.messages.a).toHaveLength(KEEP_WHEN_TRIMMED)
    expect(out.messages.a!.at(-1)!.id).toBe(`a_${TRIM_ABOVE + 19}`)
    expect(out.messages.b).toBe(messages.b) // not a candidate
    expect(messages.a).toHaveLength(TRIM_ABOVE + 20) // input untouched
  })

  it('returns the same object when nothing needs trimming', () => {
    const messages = { a: msgs('a', TRIM_ABOVE) }
    const out = trimMessages(messages, ['a', 'missing'])
    expect(out.messages).toBe(messages)
    expect(out.trimmed).toEqual([])
  })

  it('never trims a list with a message still sending, accepted or failed', () => {
    for (const delivery of ['sending', 'accepted', 'failed'] as const) {
      const list = msgs('a', TRIM_ABOVE + 5)
      list[0] = { ...list[0]!, delivery }
      expect(hasUnsettledDelivery(list)).toBe(true)
      expect(trimMessages({ a: list }, ['a']).trimmed).toEqual([])
    }
    expect(hasUnsettledDelivery(msgs('a', 3, { delivery: 'sent' }))).toBe(false)
  })
})

describe('canReloadHistory', () => {
  it('only allows platforms the store can re-fetch', () => {
    expect(canReloadHistory({ platformId: 'meta-muse', activeSessionId: 's' })).toBe(true)
    expect(canReloadHistory({ platformId: 'meta-muse' })).toBe(false)
    expect(canReloadHistory({ platformId: 'hark', activeSessionId: HARK_DRAFT_SESSION })).toBe(false)
    expect(canReloadHistory({ platformId: 'grok', selectedAgentId: 'ag' })).toBe(true)
    expect(canReloadHistory({ platformId: 'cue' })).toBe(true)
    expect(canReloadHistory({ platformId: 'dot', activeSessionId: 'room' })).toBe(false)
  })
})
