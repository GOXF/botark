import { describe, expect, it } from 'vitest'
import { proxyPoolArgs } from './botStore'

const accounts = {
  m1: { id: 'm1', platformId: 'meta-muse' },
  h1: { id: 'h1', platformId: 'hark' },
  g1: { id: 'g1', platformId: 'grok' }
}

describe('proxyPoolArgs', () => {
  it('targets every account of the ticked platforms and keeps the rest', () => {
    expect(proxyPoolArgs(accounts, ['meta-muse', 'hark'])).toEqual({ accountIds: ['m1', 'h1'], keepIds: ['g1'] })
  })

  it('a new account not in the store yet is targeted; in-flight ones are kept', () => {
    const pending = [
      { id: 'new', platformId: 'meta-muse' },
      { id: 'flying', platformId: 'meta-muse' }
    ]
    expect(proxyPoolArgs(accounts, ['meta-muse'], ['new'], pending)).toEqual({
      accountIds: ['new'],
      keepIds: ['m1', 'h1', 'g1', 'flying']
    })
  })

  it('an unticked platform gets nothing', () => {
    expect(proxyPoolArgs(accounts, ['hark'], ['g1']).accountIds).toEqual([])
  })
})
