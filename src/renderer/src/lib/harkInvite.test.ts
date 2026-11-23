import { describe, expect, it } from 'vitest'
import { inviteProgress, parseHarkInvite } from './harkInvite'

describe('parseHarkInvite', () => {
  it('parses the known shape', () => {
    const inv = parseHarkInvite({
      show: true, code: 'XS47JU', counted: 3, friendsPerReward: 3,
      landedReward: { endsAt: '2026-12-23T00:00:00Z' }
    })!
    expect(inv.link).toBe('https://hark.com/r/XS47JU')
    expect(inv.rewardEnds).toBe('2026-12-23T00:00:00Z')
    expect(inviteProgress(inv)).toEqual({ filled: 3, total: 3 })
  })
  it('handles ineligible / missing fields', () => {
    const inv = parseHarkInvite({ show: false, canClaim: false })!
    expect(inv.code).toBe('')
    expect(inviteProgress(inv)).toBeNull()
  })
  it('wraps progress per reward cycle', () => {
    expect(inviteProgress(parseHarkInvite({ code: 'A', counted: 4, friendsPerReward: 3 })!)).toEqual({ filled: 1, total: 3 })
    expect(inviteProgress(parseHarkInvite({ code: 'A', counted: 0, friendsPerReward: 3 })!)).toEqual({ filled: 0, total: 3 })
  })
})
