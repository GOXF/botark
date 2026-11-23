import { describe, expect, it } from 'vitest'
import { keepActivity } from './goxfActivity'

const base = { code: 'working', text: null, emoji: null, busy: false }

describe('keepActivity', () => {
  it('keeps busy activity', () => {
    expect(keepActivity({ ...base, busy: true })).toBe(true)
  })
  it('keeps a non-busy phrase such as "Waiting for cooldown" with subagents', () => {
    expect(keepActivity({ ...base, code: 'waiting', text: 'Waiting for cooldown', subagents: 1 })).toBe(true)
    expect(keepActivity({ ...base, code: 'waiting', subagents: 1 })).toBe(true)
  })
  it('clears null, idle, online and empty non-busy activity', () => {
    expect(keepActivity(null)).toBe(false)
    expect(keepActivity({ ...base, code: 'idle', text: 'x', busy: true })).toBe(false)
    expect(keepActivity({ ...base, code: 'online', text: 'Online' })).toBe(false)
    expect(keepActivity({ ...base, subagents: 0 })).toBe(false)
  })
})
