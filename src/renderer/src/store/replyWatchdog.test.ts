import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/types'
import { markStalledReply, REPLY_BUSY_LIMIT_MS, REPLY_IDLE_LIMIT_MS, ReplyWatchdog } from './replyWatchdog'

describe('ReplyWatchdog', () => {
  it('flags a typing bot that went quiet, but not one still streaming', () => {
    let t = 0
    const w = new ReplyWatchdog(() => t)
    w.touch('a')
    w.touch('b')
    t = REPLY_IDLE_LIMIT_MS - 1
    w.touch('b')
    t = REPLY_IDLE_LIMIT_MS
    expect(w.stalled(['a', 'b'], () => false)).toEqual(['a'])
  })

  it('waits longer while the agent reports busy', () => {
    let t = 0
    const w = new ReplyWatchdog(() => t)
    w.touch('a')
    t = REPLY_IDLE_LIMIT_MS
    expect(w.stalled(['a'], () => true)).toEqual([])
    t = REPLY_BUSY_LIMIT_MS
    expect(w.stalled(['a'], () => true)).toEqual(['a'])
  })

  it('starts the clock for bots it has not seen and drops idle ones', () => {
    let t = 0
    const w = new ReplyWatchdog(() => t)
    expect(w.stalled(['x'], () => false)).toEqual([])
    t = REPLY_IDLE_LIMIT_MS
    expect(w.stalled(['x'], () => false)).toEqual(['x'])
    expect(w.stalled([], () => false)).toEqual([])
    expect(w.stalled(['x'], () => false)).toEqual([])
  })

  it('starts a new quiet period after a bot changes session', () => {
    let t = 0
    const w = new ReplyWatchdog(() => t)
    w.touch('bot')
    t = REPLY_IDLE_LIMIT_MS - 1
    w.forget('bot')
    w.touch('bot')
    expect(w.stalled(['bot'], () => false)).toEqual([])
    t += REPLY_IDLE_LIMIT_MS
    expect(w.stalled(['bot'], () => false)).toEqual(['bot'])
  })

  it('flags an accepted user turn for the active account and leaves an answered turn usable', () => {
    const user: ChatMessage = {
      id: 'u', botId: 'bot', accountId: 'account', role: 'user', text: 'hi', createdAt: 1, delivery: 'accepted'
    }
    const pending = [user]
    expect(markStalledReply(pending, 'other')).toBe(pending)
    expect(markStalledReply(pending, 'account')[0]).toMatchObject({ delivery: 'no-reply' })
    const answered: ChatMessage[] = [user, { ...user, id: 'b', role: 'bot', delivery: undefined }]
    expect(markStalledReply(answered, 'account')).toBe(answered)
  })
})
