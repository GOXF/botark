import { describe, expect, it } from 'vitest'
import { reachedDoneUrl } from './goxfInApp'

describe('reachedDoneUrl', () => {
  const done = 'https://app.hark.com/settings/connected-accounts'
  it('matches the return page with query or trailing slash', () => {
    expect(reachedDoneUrl('https://app.hark.com/settings/connected-accounts?connected=github', done)).toBe(true)
    expect(reachedDoneUrl('https://app.hark.com/settings/connected-accounts/', done)).toBe(true)
  })
  it('ignores the provider pages and other origins', () => {
    expect(reachedDoneUrl('https://github.com/login/oauth/authorize?x=1', done)).toBe(false)
    expect(reachedDoneUrl('https://evil.example/settings/connected-accounts', done)).toBe(false)
    expect(reachedDoneUrl('not a url', done)).toBe(false)
  })
})

