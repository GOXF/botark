import { describe, expect, it } from 'vitest'
import { classifyBot, classifyRoom, type BotSignals } from './boardStatus'

const base: BotSignals = { typing: false, live: false, harkWorking: 0, harkDoneAt: 0, asks: 0, unread: 0 }

describe('board columns', () => {
  it('asks beat everything else', () => {
    expect(classifyBot({ ...base, asks: 1, typing: true, accountStatus: 'error' })).toBe('wait')
    expect(classifyBot({ ...base, accountStatus: 'attention' })).toBe('wait')
  })
  it('failures before work in flight', () => {
    expect(classifyBot({ ...base, lastDelivery: 'failed', typing: true })).toBe('fail')
    expect(classifyBot({ ...base, accountStatus: 'error' })).toBe('fail')
  })
  it('running, then done, then idle', () => {
    expect(classifyBot({ ...base, harkWorking: 2 })).toBe('run')
    expect(classifyBot({ ...base, live: true })).toBe('run')
    expect(classifyBot({ ...base, harkDoneAt: 5 })).toBe('done')
    expect(classifyBot({ ...base, unread: 3 })).toBe('done')
    expect(classifyBot(base)).toBe('idle')
  })
  it('rooms', () => {
    expect(classifyRoom({ speaking: true, error: false })).toBe('run')
    expect(classifyRoom({ speaking: true, error: true })).toBe('fail')
    expect(classifyRoom({ speaking: false, error: false })).toBe('idle')
  })
})
